// Whois 查询的纯逻辑：域名规范化、RDAP 解析、RDAP 优先 + 原文兜底的查询流程
import { httpGetJson, netWhois, type NetCallFn } from '@/native/net'

/** RDAP 聚合入口（按域名后缀 302 到各注册局） */
export const RDAP_DOMAIN_URL = 'https://rdap.org/domain/'

/** 域名最大长度 */
const MAX_DOMAIN_LEN = 253

/** 单个标签：字母数字与连字符，不以连字符开头结尾，最长 63 */
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** 顶级域：纯字母 2~63 位，或 punycode（xn--） */
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/

/**
 * 规范化域名输入：去协议、账号、路径、查询、端口、末尾点，转小写。
 * 不做 punycode 转换，含非 ASCII 字符的直接判无效。
 *
 * @param input 用户输入，可以是域名或完整网址
 * @returns 规范化后的域名；不合法为 null
 * @example normalizeDomain('https://User@WWW.Example.com:8080/a?b#c') // 'www.example.com'
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split(/[/?#]/)[0]
  const at = s.lastIndexOf('@')
  if (at >= 0) s = s.slice(at + 1)
  s = s.replace(/:\d*$/, '').replace(/\.$/, '')
  if (!s || s.length > MAX_DOMAIN_LEN) return null
  const labels = s.split('.')
  if (labels.length < 2) return null
  if (!labels.every((l) => LABEL_RE.test(l))) return null
  if (!TLD_RE.test(labels[labels.length - 1])) return null
  return s
}

/** RDAP 事件对应的字段 */
const EVENT_FIELDS: Record<string, 'registered' | 'expires' | 'updated'> = {
  registration: 'registered',
  expiration: 'expires',
  'last changed': 'updated',
}

/** 解析后的域名 RDAP 信息 */
export interface RdapDomain {
  /** 域名 */
  domain: string
  /** 注册商名称 */
  registrar: string | null
  /** 注册时间（ISO 原文） */
  registered: string | null
  /** 到期时间（ISO 原文） */
  expires: string | null
  /** 最近更新时间（ISO 原文） */
  updated: string | null
  /** 状态列表 */
  status: string[]
  /** DNS 服务器（小写） */
  nameservers: string[]
}

/** 取 vcard 里的 fn 字段 */
function vcardName(vcard: unknown): string | null {
  if (!Array.isArray(vcard) || !Array.isArray(vcard[1])) return null
  for (const item of vcard[1] as unknown[]) {
    if (Array.isArray(item) && item[0] === 'fn' && typeof item[3] === 'string' && item[3]) return item[3]
  }
  return null
}

/**
 * 解析 RDAP 域名响应。事件按 `eventAction` 映射：registration→注册、expiration→到期、last changed→更新。
 *
 * @param json RDAP 响应 JSON
 * @returns 解析结果；不像域名响应（没有 ldhName）返回 null
 * @example parseRdapDomain({ ldhName: 'EXAMPLE.COM', status: ['active'] })?.domain // 'example.com'
 */
export function parseRdapDomain(json: unknown): RdapDomain | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  if (typeof j.ldhName !== 'string' || !j.ldhName) return null
  const out: RdapDomain = {
    domain: j.ldhName.toLowerCase(),
    registrar: null,
    registered: null,
    expires: null,
    updated: null,
    status: Array.isArray(j.status) ? (j.status as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    nameservers: [],
  }
  if (Array.isArray(j.events)) {
    for (const e of j.events as Array<Record<string, unknown>>) {
      const field = typeof e?.eventAction === 'string' ? EVENT_FIELDS[e.eventAction.toLowerCase()] : undefined
      if (field && typeof e.eventDate === 'string' && !out[field]) out[field] = e.eventDate
    }
  }
  if (Array.isArray(j.entities)) {
    for (const ent of j.entities as Array<Record<string, unknown>>) {
      if (Array.isArray(ent?.roles) && (ent.roles as unknown[]).includes('registrar')) {
        out.registrar = vcardName(ent.vcardArray)
        if (out.registrar) break
      }
    }
  }
  if (Array.isArray(j.nameservers)) {
    for (const ns of j.nameservers as Array<Record<string, unknown>>) {
      if (typeof ns?.ldhName === 'string') out.nameservers.push(ns.ldhName.toLowerCase())
    }
  }
  return out
}

/**
 * 把 RDAP 的 ISO 时间显示成 `YYYY-MM-DD HH:mm (UTC)`。
 *
 * @param iso ISO 时间文本
 * @returns 显示文本；无法解析时原样返回
 * @example formatRdapDate('2024-03-05T08:09:00Z') // '2024-03-05 08:09 (UTC)'
 */
export function formatRdapDate(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} (UTC)`
}

/** 查询结果：RDAP 结构化，或 Whois 原文 */
export type WhoisOutcome =
  | { kind: 'rdap'; data: RdapDomain }
  | { kind: 'whois'; server: string; text: string; truncated: boolean }

/**
 * 查域名：先 RDAP，查不到（404、失败、解析不出）再用 Whois 原文兜底。
 *
 * @param domain 已规范化的域名
 * @param call 原生调用函数，默认走 bridge（测试时注入）
 * @param signal 取消信号
 * @returns RDAP 或 Whois 结果；两条路都失败时抛出 Whois 的错误
 * @example const r = await queryDomain('example.com')
 */
export async function queryDomain(domain: string, call?: NetCallFn, signal?: AbortSignal): Promise<WhoisOutcome> {
  try {
    const data = parseRdapDomain(await httpGetJson(RDAP_DOMAIN_URL + encodeURIComponent(domain), call, { signal }))
    if (data) return { kind: 'rdap', data }
  } catch (e) {
    // 用户取消不再兜底
    if (signal?.aborted) throw e
  }
  const w = await netWhois(domain, undefined, call, signal)
  return { kind: 'whois', server: w.server, text: w.text, truncated: w.truncated }
}
