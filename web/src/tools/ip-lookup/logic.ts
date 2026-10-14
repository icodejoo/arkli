// IP 查询的纯逻辑：输入分类与校验、ipinfo / RDAP 响应解析、查询流程（ipinfo 优先，RDAP 兜底）
import { httpGetJson, type NetCallFn, type ResolvedAddress } from '@/native/net'
import { normalizeDomain } from '../whois/logic'

/** ipinfo 免费端点（无 token）的前缀 */
export const IPINFO_BASE = 'https://ipinfo.io/'
/** ipinfo 查询本机公网 IP 的地址 */
export const IPINFO_SELF_URL = 'https://ipinfo.io/json'
/** ipinfo 备用：只返回本机 IP 的接口 */
export const IPIFY_URL = 'https://api.ipify.org?format=json'
/** RDAP 的 IP 查询前缀 */
export const RDAP_IP_URL = 'https://rdap.org/ip/'

/** IPv4 十进制四段 */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** IPv6 一个十六进制组 */
const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/i

/**
 * 是否合法 IPv4（四段十进制，不允许前导零）。
 *
 * @param s 文本
 * @returns 合法为 true
 * @example isIPv4('8.8.8.8') // true
 */
export function isIPv4(s: string): boolean {
  return IPV4_RE.test(s)
}

/** 数一段 `:` 分隔的组占几个 16 位；末尾允许内嵌 IPv4（占 2 组）。不合法返回 -1 */
function countGroups(part: string, allowV4Tail: boolean): number {
  if (part === '') return 0
  const groups = part.split(':')
  let n = 0
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    if (allowV4Tail && i === groups.length - 1 && g.includes('.')) {
      if (!isIPv4(g)) return -1
      n += 2
    } else if (HEX_GROUP_RE.test(g)) {
      n += 1
    } else {
      return -1
    }
  }
  return n
}

/**
 * 是否合法 IPv6（支持 `::` 压缩与末尾内嵌 IPv4，不含方括号与区域 id）。
 *
 * @param s 文本
 * @returns 合法为 true
 * @example isIPv6('2001:db8::1') // true
 */
export function isIPv6(s: string): boolean {
  if (!s.includes(':') || !/^[0-9a-f:.]+$/i.test(s)) return false
  const parts = s.split('::')
  if (parts.length > 2) return false
  if (parts.length === 1) return countGroups(s, true) === 8
  const left = countGroups(parts[0], false)
  const right = countGroups(parts[1], true)
  return left >= 0 && right >= 0 && left + right <= 7
}

/** 输入分类结果 */
export type InputKind = { kind: 'ipv4' | 'ipv6' | 'domain'; value: string } | { kind: 'invalid'; value: string }

/**
 * 判断输入是 IP 还是域名。会去掉 IPv6 的方括号与 `%区域` 后缀；域名按 whois 的规则规范化。
 *
 * @param input 用户输入
 * @returns 类别与规范化后的值
 * @example classifyInput('[2001:db8::1]') // { kind: 'ipv6', value: '2001:db8::1' }
 */
export function classifyInput(input: string): InputKind {
  let s = input.trim()
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'))
  s = s.replace(/%.*$/, '')
  if (isIPv4(s)) return { kind: 'ipv4', value: s }
  if (isIPv6(s)) return { kind: 'ipv6', value: s.toLowerCase() }
  const d = normalizeDomain(input)
  return d ? { kind: 'domain', value: d } : { kind: 'invalid', value: input.trim() }
}

/**
 * 从解析结果里挑一个要查的地址：优先 IPv4。
 *
 * @param addresses 解析出的地址
 * @returns IP 文本；没有地址为 null
 * @example pickAddress([{ ip: '::1', family: 6 }, { ip: '1.1.1.1', family: 4 }]) // '1.1.1.1'
 */
export function pickAddress(addresses: ResolvedAddress[]): string | null {
  const v4 = addresses.find((a) => a.family === 4)
  return (v4 ?? addresses[0])?.ip ?? null
}

/** 统一的 IP 信息，两种来源共用，没有的字段为 null / 空数组 */
export interface IpInfo {
  /** 数据来源 */
  source: 'ipinfo' | 'rdap'
  /** 被查询的 IP */
  ip: string
  /** 国家 / 地区代码，如 US */
  country: string | null
  /** 运营商 / 组织名 */
  org: string | null
  /** 自治系统号，如 AS13335 */
  asn: string | null
  /** 反向解析的主机名 */
  hostname: string | null
  /** 网段名称（RDAP） */
  name: string | null
  /** 网段句柄（RDAP） */
  handle: string | null
  /** 起止地址，如 `1.0.0.0 - 1.0.0.255`（RDAP） */
  range: string | null
  /** CIDR 列表（RDAP） */
  cidrs: string[]
}

/** 造一个全空的结果 */
function emptyInfo(source: IpInfo['source'], ip: string): IpInfo {
  return { source, ip, country: null, org: null, asn: null, hostname: null, name: null, handle: null, range: null, cidrs: [] }
}

/** 取非空字符串，否则 null */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * 解析 ipinfo.io 的 JSON。只取国家代码、组织 / ASN、主机名，不取城市与经纬度。
 *
 * @param json 响应 JSON
 * @returns 解析结果；没有 ip 字段、是保留地址（bogon）或是错误响应时为 null
 * @example parseIpinfo({ ip: '1.1.1.1', org: 'AS13335 Cloudflare, Inc.', country: 'US' })?.asn // 'AS13335'
 */
export function parseIpinfo(json: unknown): IpInfo | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  const ip = str(j.ip)
  if (!ip || j.bogon === true || j.error) return null
  const info = emptyInfo('ipinfo', ip)
  info.country = str(j.country)
  info.hostname = str(j.hostname)
  const org = str(j.org)
  if (org) {
    const m = /^(AS\d+)\s+(.*)$/i.exec(org)
    if (m) {
      info.asn = m[1].toUpperCase()
      info.org = m[2] || null
    } else {
      info.org = org
    }
  }
  return info
}

/**
 * 解析 RDAP 的 IP 网段响应。
 *
 * @param json 响应 JSON
 * @param ip 被查询的 IP（RDAP 响应里没有它）
 * @returns 解析结果；不像网段响应（没有 name、handle 也没有地址范围）为 null
 * @example parseRdapIp({ name: 'APNIC-LABS', handle: '1.0.0.0 - 1.0.0.255' }, '1.0.0.1')?.name // 'APNIC-LABS'
 */
export function parseRdapIp(json: unknown, ip: string): IpInfo | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  const info = emptyInfo('rdap', ip)
  info.name = str(j.name)
  info.handle = str(j.handle)
  info.country = str(j.country)
  const start = str(j.startAddress)
  const end = str(j.endAddress)
  if (start && end) info.range = `${start} - ${end}`
  if (Array.isArray(j.cidr0_cidrs)) {
    for (const c of j.cidr0_cidrs as Array<Record<string, unknown>>) {
      const prefix = str(c?.v4prefix) ?? str(c?.v6prefix)
      if (prefix && typeof c.length === 'number') info.cidrs.push(`${prefix}/${c.length}`)
    }
  }
  if (!info.name && !info.handle && !info.range) return null
  return info
}

/**
 * 查一个 IP：先 ipinfo，失败或解析不出再回退 RDAP。
 *
 * @param ip 已校验的 IP
 * @param call 原生调用函数，默认走 bridge（测试时注入）
 * @param signal 取消信号
 * @returns IP 信息；两个来源都失败时抛出 RDAP 的错误
 * @example const info = await lookupIp('1.1.1.1')
 */
export async function lookupIp(ip: string, call?: NetCallFn, signal?: AbortSignal): Promise<IpInfo> {
  try {
    const info = parseIpinfo(await httpGetJson(`${IPINFO_BASE}${ip}/json`, call, { signal }))
    if (info) return info
  } catch (e) {
    if (signal?.aborted) throw e
  }
  const rdap = parseRdapIp(await httpGetJson(RDAP_IP_URL + ip, call, { signal }), ip)
  if (!rdap) throw new Error('没有查到这个 IP 的信息')
  return rdap
}

/**
 * 查本机公网 IP：先 ipinfo 自查；失败时用 ipify 拿到 IP 再走 {@link lookupIp}。
 *
 * @param call 原生调用函数，默认走 bridge（测试时注入）
 * @param signal 取消信号
 * @returns 本机公网 IP 的信息
 * @example const me = await lookupMyIp()
 */
export async function lookupMyIp(call?: NetCallFn, signal?: AbortSignal): Promise<IpInfo> {
  try {
    const info = parseIpinfo(await httpGetJson(IPINFO_SELF_URL, call, { signal }))
    if (info) return info
  } catch (e) {
    if (signal?.aborted) throw e
  }
  const j = await httpGetJson<{ ip?: unknown }>(IPIFY_URL, call, { signal })
  const ip = str(j?.ip)
  if (!ip || !(isIPv4(ip) || isIPv6(ip))) throw new Error('没能取到本机公网 IP')
  return lookupIp(ip, call, signal)
}
