// 短链还原的纯逻辑：逐跳请求（不自动跟随），自己读 location、解析相对地址、查循环与跳数
import { netHttp, type NetCallFn } from '@/native/net'

/** 最多请求几跳 */
export const MAX_HOPS = 10

/** 每跳只需要状态与头，正文最多读这么多字节 */
const HOP_MAX_BYTES = 1024

/** 单跳请求超时（毫秒） */
const HOP_TIMEOUT_MS = 8000

/** 一跳记录 */
export interface Hop {
  /** 本跳请求的地址 */
  url: string
  /** 本跳返回的状态码 */
  status: number
  /** 本跳指向的下一地址（已解析成绝对地址），没有为空 */
  location?: string
}

/** 链路结束原因 */
export type TraceOutcome =
  | 'done' // 拿到非跳转响应，finalUrl 是落地页
  | 'loop' // 又回到了走过的地址
  | 'too-many' // 超过最大跳数仍在跳转
  | 'no-location' // 是跳转状态却没有 location
  | 'bad-location' // location 无法解析
  | 'unsupported' // 指向非 http(s)（如 App 唤起链接）
  | 'error' // 请求本身失败

/** 链路追踪结果 */
export interface TraceResult {
  /** 逐跳记录 */
  hops: Hop[]
  /** 最终地址：done 为落地页；其余为停下时最后已知的地址 */
  finalUrl: string
  /** 结束原因 */
  outcome: TraceOutcome
  /** outcome 为 error 时的错误信息 */
  error?: string
}

/** 追踪选项 */
export interface TraceOptions {
  /** 最多请求几跳，默认 {@link MAX_HOPS} */
  maxHops?: number
  /** 取消信号 */
  signal?: AbortSignal
  /** 每完成一跳的回调，用来实时刷新页面 */
  onHop?: (hop: Hop) => void
}

/** 是否是跳转状态码 */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 去掉 hash 的比较键，hash 不会发给服务器 */
function key(url: string): string {
  const i = url.indexOf('#')
  return i < 0 ? url : url.slice(0, i)
}

/**
 * 按当前地址解析 location（支持相对路径、`//host/x`）。
 *
 * @param location 响应头里的 location
 * @param base 当前请求地址
 * @returns 绝对地址；解析失败为 null
 * @example resolveLocation('/b', 'https://a.com/x') // 'https://a.com/b'
 */
export function resolveLocation(location: string, base: string): string | null {
  try {
    return new URL(location.trim(), base).href
  } catch {
    return null
  }
}

/**
 * 逐跳还原短链：每跳 GET 且不自动跟随，读 location 决定下一跳。
 *
 * @param startUrl 起始地址（须是完整 http(s) URL）
 * @param call 原生调用函数，默认走 bridge（测试时注入假实现）
 * @param options 跳数上限、取消信号与逐跳回调
 * @returns 跳转链与最终地址；请求失败不抛错，outcome 为 error 并保留已走完的跳
 * @example const r = await traceRedirects('https://t.cn/abc'); console.log(r.finalUrl)
 */
export async function traceRedirects(startUrl: string, call?: NetCallFn, options: TraceOptions = {}): Promise<TraceResult> {
  const max = options.maxHops ?? MAX_HOPS
  const hops: Hop[] = []
  const seen = new Set<string>()
  let current = startUrl
  while (true) {
    if (seen.has(key(current))) return { hops, finalUrl: current, outcome: 'loop' }
    if (hops.length >= max) return { hops, finalUrl: current, outcome: 'too-many' }
    seen.add(key(current))
    let status: number
    let loc: string
    try {
      const res = await netHttp({ url: current, followRedirects: false, maxBytes: HOP_MAX_BYTES, timeoutMs: HOP_TIMEOUT_MS }, call, options.signal)
      status = res.status
      loc = res.headers.location ?? ''
    } catch (e) {
      return { hops, finalUrl: current, outcome: 'error', error: (e as { message?: string }).message || '请求失败' }
    }
    if (!isRedirectStatus(status)) {
      const hop: Hop = { url: current, status }
      hops.push(hop)
      options.onHop?.(hop)
      return { hops, finalUrl: current, outcome: 'done' }
    }
    if (!loc) {
      const hop: Hop = { url: current, status }
      hops.push(hop)
      options.onHop?.(hop)
      return { hops, finalUrl: current, outcome: 'no-location' }
    }
    const next = resolveLocation(loc, current)
    const hop: Hop = { url: current, status, location: next ?? loc }
    hops.push(hop)
    options.onHop?.(hop)
    if (!next) return { hops, finalUrl: current, outcome: 'bad-location' }
    if (!/^https?:/i.test(next)) return { hops, finalUrl: next, outcome: 'unsupported' }
    current = next
  }
}

/** 结束原因对应的中文说明 */
const OUTCOME_TEXT: Record<TraceOutcome, string> = {
  done: '已到达最终页面',
  loop: '检测到循环跳转，已停止',
  'too-many': '跳转次数过多，已停止',
  'no-location': '服务器返回了跳转状态，却没给目标地址',
  'bad-location': '目标地址无法解析',
  unsupported: '目标不是网页地址（可能是唤起 App 的链接）',
  error: '请求失败',
}

/**
 * 结束原因转中文说明。
 *
 * @param outcome 结束原因
 * @returns 中文说明
 * @example outcomeText('loop') // '检测到循环跳转，已停止'
 */
export function outcomeText(outcome: TraceOutcome): string {
  return OUTCOME_TEXT[outcome]
}
