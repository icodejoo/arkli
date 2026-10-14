// 网页源码获取的纯逻辑：URL 规范化、正文截断、响应头整理、文件名

/** 正文最多显示的字符数（约 200KB） */
export const MAX_SHOW_CHARS = 200 * 1024

/** 默认协议前缀 */
const DEFAULT_SCHEME = 'https://'

/** 允许的协议 */
const ALLOWED_PROTOCOLS = ['http:', 'https:']

/** 形如 `xxx://` 的协议前缀 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/** 默认保存文件名 */
const DEFAULT_FILE_NAME = 'source.txt'

/** URL 规范化结果 */
export type NormalizeResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * 规范化并校验用户输入的网址：缺协议补 https://，只接受 http / https。
 *
 * @param input 用户输入
 * @returns 成功给出完整 URL，失败给出中文原因
 * @example normalizeUrl('example.com/a') // { ok: true, url: 'https://example.com/a' }
 */
export function normalizeUrl(input: string): NormalizeResult {
  const text = input.trim()
  if (!text) return { ok: false, error: '请输入网址' }
  if (/\s/.test(text)) return { ok: false, error: '网址里不能有空格' }
  let full = text
  if (SCHEME_RE.test(text)) {
    if (!/^https?:\/\//i.test(text)) return { ok: false, error: '只支持 http 和 https' }
  } else {
    full = DEFAULT_SCHEME + text
  }
  let u: URL
  try {
    u = new URL(full)
  } catch {
    return { ok: false, error: '网址格式不对' }
  }
  if (!ALLOWED_PROTOCOLS.includes(u.protocol) || !u.hostname) return { ok: false, error: '网址格式不对' }
  return { ok: true, url: u.href }
}

/** 截断后的正文 */
export interface ShownBody {
  /** 要显示的文本 */
  text: string
  /** 是否被截断 */
  truncated: boolean
  /** 原文总字符数 */
  total: number
}

/**
 * 截取正文前 N 个字符用于显示。
 *
 * @param body 正文
 * @param max 最大字符数，默认 {@link MAX_SHOW_CHARS}
 * @returns 截取结果
 * @example clipBody('abcdef', 3) // { text: 'abc', truncated: true, total: 6 }
 */
export function clipBody(body: string, max = MAX_SHOW_CHARS): ShownBody {
  if (body.length <= max) return { text: body, truncated: false, total: body.length }
  return { text: body.slice(0, max), truncated: true, total: body.length }
}

/**
 * 把响应头整理成按键名排序的数组，便于列表展示。
 *
 * @param headers 响应头（键小写）
 * @returns `[名, 值]` 数组
 * @example sortHeaders({ b: '2', a: '1' }) // [['a','1'],['b','2']]
 */
export function sortHeaders(headers: Record<string, string>): Array<[string, string]> {
  return Object.keys(headers)
    .sort()
    .map((k) => [k, headers[k]] as [string, string])
}

/**
 * 按网址生成保存用的文件名：`主机名.txt`；content-type 是 json / html 时用对应扩展名。
 *
 * @param url 最终地址
 * @param contentType 响应 content-type，可空
 * @returns 文件名
 * @example sourceFileName('https://a.com/x', 'text/html') // 'a.com.html'
 */
export function sourceFileName(url: string, contentType = ''): string {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return DEFAULT_FILE_NAME
  }
  const ct = contentType.toLowerCase()
  const ext = ct.includes('json') ? 'json' : ct.includes('html') ? 'html' : 'txt'
  return `${host || 'source'}.${ext}`
}
