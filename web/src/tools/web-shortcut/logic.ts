// 网页转应用：网址与名称校验、默认名称、快捷方式标识（纯逻辑）

/** 名称长度上限（与原生一致） */
export const MAX_LABEL = 24
/** 允许的协议 */
const ALLOWED_PROTOCOLS = ['https:', 'http:']
/** 标识前缀 */
const ID_PREFIX = 'web-'

/** 网址校验结果：成功带规范化网址，失败带中文提示 */
export type UrlResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * 校验并规范化网址：没写协议默认补 `https://`，只允许 http / https，主机名要像样。
 *
 * @param input 用户输入
 * @returns 规范化网址或错误
 * @example checkUrl('zhihu.com') // { ok: true, url: 'https://zhihu.com/' }
 */
export function checkUrl(input: string): UrlResult {
  const raw = input.trim()
  if (!raw) return { ok: false, error: '先填网址' }
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[^/]*:\d+(\/|$)/.test(raw)
  const withScheme = hasScheme ? raw : `https://${raw}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return { ok: false, error: '网址格式不对' }
  }
  if (!ALLOWED_PROTOCOLS.includes(u.protocol)) return { ok: false, error: '只支持 http / https 网址' }
  const host = u.hostname
  const looksOk = host === 'localhost' || host.includes('.') || host.includes(':')
  if (!host || !looksOk) return { ok: false, error: '网址格式不对' }
  return { ok: true, url: u.href }
}

/**
 * 校验名称：去首尾空白，1~24 字。
 *
 * @param label 用户输入
 * @returns 错误说明；合法为 null
 */
export function checkLabel(label: string): string | null {
  const s = label.trim()
  if (!s) return '给应用起个名字'
  if (s.length > MAX_LABEL) return `名字最多 ${MAX_LABEL} 字`
  return null
}

/**
 * 按网址猜一个默认名称：主机名去掉 `www.`，取第一段（`www.zhihu.com` -> `zhihu`）。
 *
 * @param url 规范化网址
 * @returns 名称；解析失败为空串
 * @example suggestLabel('https://www.zhihu.com/') // 'zhihu'
 */
export function suggestLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    const first = host.split('.')[0] ?? ''
    return first.slice(0, MAX_LABEL)
  } catch {
    return ''
  }
}

/**
 * 由网址生成稳定的快捷方式标识：同一网址总是同一个 id，重复添加是更新而不是多出一个。
 *
 * @param url 规范化网址
 * @returns 形如 `web-1a2b3c4d`，长度远小于 64
 */
export function makeShortcutId(url: string): string {
  // djb2 哈希，够区分网址即可
  let h = 5381
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0
  return `${ID_PREFIX}${h.toString(16).padStart(8, '0')}`
}
