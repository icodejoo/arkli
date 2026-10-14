/**
 * 联网能力封装：HTTP 请求、DNS 解析、TCP 连通、Whois、下行测速。
 * 页面自己的出站网络被 CSP 与原生白名单封死，所有联网都走原生 `native.net.*`。
 * 契约见 docs/design/bridge-protocol.md（原生侧按本文件的类型实现）。
 *
 * 没有宿主（桌面浏览器调试）时一律抛 {@link NativeUnavailableError}，没有浏览器兜底。
 * 注入了自定义 `call`（测试用）时不检查宿主。
 */
import { call as bridgeCall, isNativeAvailable } from './bridge'
import { NativeUnavailableError } from './system'

export { NativeUnavailableError }

/** 单次原生调用的选项 */
export interface NetCallOptions {
  /** 桥超时毫秒数；0 表示不超时 */
  timeoutMs?: number
  /** 取消信号，触发后原生会中止请求 */
  signal?: AbortSignal
}

/** 原生调用函数形状，便于注入测试 */
export type NetCallFn = <T = unknown>(method: string, params?: Record<string, unknown>, options?: NetCallOptions) => Promise<T>

/** 方法名常量 */
export const NET_METHODS = {
  http: 'native.net.http',
  resolve: 'native.net.resolve',
  tcp: 'native.net.tcp',
  whois: 'native.net.whois',
  speed: 'native.net.speed',
} as const

/** HTTP 默认超时（毫秒） */
export const HTTP_TIMEOUT_MS = 10_000
/** HTTP 超时上限（毫秒） */
export const HTTP_TIMEOUT_MAX_MS = 20_000
/** HTTP 响应体上限（字节，2MB） */
export const HTTP_MAX_BYTES = 2 * 1024 * 1024
/** 默认最大重定向次数 */
export const HTTP_MAX_REDIRECTS = 5
/** TCP 默认超时（毫秒） */
export const TCP_TIMEOUT_MS = 5000
/** 测速默认最大字节数（25MB） */
export const SPEED_MAX_BYTES = 25 * 1024 * 1024
/** 测速默认时长（毫秒） */
export const SPEED_DURATION_MS = 8000
/** 桥超时在原生超时之上多留的余量（毫秒），避免桥先于原生超时 */
const BRIDGE_SLACK_MS = 5000
/** Whois / 解析等没有显式超时的调用，桥超时（毫秒） */
const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000

/** HTTP 请求参数 */
export interface HttpParams {
  /** 目标地址，仅 http / https */
  url: string
  /** 方法，默认 GET */
  method?: 'GET' | 'HEAD'
  /** 请求头 */
  headers?: Record<string, string>
  /** 是否跟随重定向，默认 true */
  followRedirects?: boolean
  /** 最多跟随几次重定向，默认 5，上限 10 */
  maxRedirects?: number
  /** 超时毫秒，默认 10000，上限 20000 */
  timeoutMs?: number
  /** 响应体最多读多少字节，默认 2MB（也是上限） */
  maxBytes?: number
  /** 响应体编码，默认 text；二进制内容用 base64 */
  responseType?: 'text' | 'base64'
}

/** 一次重定向记录 */
export interface RedirectHop {
  /** 发生跳转的那个地址 */
  url: string
  /** 该地址返回的状态码 */
  status: number
  /** 它指向的 Location */
  location: string
}

/** HTTP 响应 */
export interface HttpResponse {
  /** 状态码 */
  status: number
  /** 状态描述 */
  statusText: string
  /** 最终地址（跟随重定向之后） */
  url: string
  /** 经过的重定向；`followRedirects:false` 时为空 */
  redirects: RedirectHop[]
  /** 响应头，键小写 */
  headers: Record<string, string>
  /** 响应体：text 为文本，base64 为 base64 串 */
  body: string
  /** body 的编码 */
  bodyEncoding: 'text' | 'base64'
  /** 是否因超过 maxBytes 被截断 */
  truncated: boolean
  /** 总耗时（毫秒） */
  elapsedMs: number
}

/** DNS 解析出的一个地址 */
export interface ResolvedAddress {
  /** IP 文本 */
  ip: string
  /** 4 或 6 */
  family: 4 | 6
}

/** DNS 解析结果 */
export interface ResolveResult {
  /** 全部地址 */
  addresses: ResolvedAddress[]
  /** 耗时（毫秒） */
  elapsedMs: number
}

/** TCP 连接结果 */
export interface TcpResult {
  /** 是否连上 */
  ok: boolean
  /** 连接耗时（毫秒） */
  elapsedMs: number
  /** 失败原因 */
  error?: string
}

/** Whois 结果 */
export interface WhoisResult {
  /** 最终应答的 Whois 服务器 */
  server: string
  /** 原文（至多 64KB） */
  text: string
  /** 是否被截断 */
  truncated: boolean
}

/** 测速参数 */
export interface SpeedParams {
  /** 下载地址 */
  url: string
  /** 最多下载字节，默认 25MB，上限 50MB */
  maxBytes?: number
  /** 最长时长毫秒，默认 8000，上限 15000 */
  durationMs?: number
}

/** 测速结果 */
export interface SpeedResult {
  /** 实际下载字节数 */
  bytes: number
  /** 耗时（毫秒） */
  elapsedMs: number
  /** 平均速率（比特每秒） */
  bps: number
}

/** HTTP 状态码非 2xx 时抛出 */
export class HttpStatusError extends Error {
  /** 响应状态码 */
  readonly status: number

  /**
   * @param status 状态码
   * @param url 请求地址
   */
  constructor(status: number, url: string) {
    super(`请求失败（HTTP ${status}）：${url}`)
    this.name = 'HttpStatusError'
    this.status = status
  }
}

/** 没有宿主且用的是默认 call 时抛错 */
function requireHost(method: string, call: NetCallFn): void {
  if (call === (bridgeCall as NetCallFn) && !isNativeAvailable()) throw new NativeUnavailableError(method)
}

/**
 * 发 HTTP(S) 请求。
 *
 * @param params 请求参数，见 {@link HttpParams}
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param signal 取消信号
 * @returns 响应；原生错误码有 BAD_PARAMS / NETWORK / TIMEOUT / PERMISSION_DENIED（内网目标）
 * @example const r = await netHttp({ url: 'https://example.com', followRedirects: false })
 */
export function netHttp(params: HttpParams, call: NetCallFn = bridgeCall, signal?: AbortSignal): Promise<HttpResponse> {
  requireHost(NET_METHODS.http, call)
  const wait = Math.min(params.timeoutMs ?? HTTP_TIMEOUT_MS, HTTP_TIMEOUT_MAX_MS)
  return call<HttpResponse>(NET_METHODS.http, { ...params }, { timeoutMs: wait * (1 + (params.maxRedirects ?? HTTP_MAX_REDIRECTS)) + BRIDGE_SLACK_MS, signal })
}

/**
 * 解析域名的 A / AAAA 记录。
 *
 * @param host 域名
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param signal 取消信号
 * @returns 地址列表与耗时
 * @example const { addresses } = await netResolve('example.com')
 */
export function netResolve(host: string, call: NetCallFn = bridgeCall, signal?: AbortSignal): Promise<ResolveResult> {
  requireHost(NET_METHODS.resolve, call)
  return call<ResolveResult>(NET_METHODS.resolve, { host }, { timeoutMs: DEFAULT_BRIDGE_TIMEOUT_MS, signal })
}

/**
 * TCP 连接一次，用耗时当延迟。内网目标会被拒绝。
 *
 * @param host 主机
 * @param port 端口
 * @param timeoutMs 超时毫秒，默认 5000
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param signal 取消信号
 * @returns `{ ok, elapsedMs, error? }`；连不上不抛错，ok 为 false
 * @example const r = await netTcp('1.1.1.1', 443)
 */
export function netTcp(host: string, port: number, timeoutMs = TCP_TIMEOUT_MS, call: NetCallFn = bridgeCall, signal?: AbortSignal): Promise<TcpResult> {
  requireHost(NET_METHODS.tcp, call)
  return call<TcpResult>(NET_METHODS.tcp, { host, port, timeoutMs }, { timeoutMs: timeoutMs + BRIDGE_SLACK_MS, signal })
}

/**
 * 查 Whois 原文（43 端口，默认从 whois.iana.org 跟随 referral）。
 *
 * @param query 域名或 IP
 * @param server 指定 Whois 服务器，缺省自动找
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param signal 取消信号
 * @returns 服务器、原文与是否截断
 * @example const { text } = await netWhois('example.com')
 */
export function netWhois(query: string, server?: string, call: NetCallFn = bridgeCall, signal?: AbortSignal): Promise<WhoisResult> {
  requireHost(NET_METHODS.whois, call)
  const params: Record<string, unknown> = { query }
  if (server) params.server = server
  return call<WhoisResult>(NET_METHODS.whois, params, { timeoutMs: DEFAULT_BRIDGE_TIMEOUT_MS, signal })
}

/**
 * 下行测速：原生流式下载并计数，不返回内容，到时或到量即停。
 *
 * @param params 测速参数，见 {@link SpeedParams}
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param signal 取消信号
 * @returns 字节数、耗时与平均速率
 * @example const { bps } = await netSpeed({ url: 'https://speed.cloudflare.com/__down?bytes=25000000' })
 */
export function netSpeed(params: SpeedParams, call: NetCallFn = bridgeCall, signal?: AbortSignal): Promise<SpeedResult> {
  requireHost(NET_METHODS.speed, call)
  const wait = (params.durationMs ?? SPEED_DURATION_MS) + BRIDGE_SLACK_MS * 2
  return call<SpeedResult>(NET_METHODS.speed, { ...params }, { timeoutMs: wait, signal })
}

/** 可选的请求附加项 */
export interface GetOptions {
  /** 请求头 */
  headers?: Record<string, string>
  /** 取消信号 */
  signal?: AbortSignal
}

/**
 * GET 一个 JSON 接口。非 2xx 抛 {@link HttpStatusError}，正文不是合法 JSON 抛 SyntaxError。
 *
 * @param url 接口地址
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param options 请求头与取消信号
 * @returns 解析后的 JSON
 * @example const j = await httpGetJson<{ ip: string }>('https://ipinfo.io/json')
 */
export async function httpGetJson<T = unknown>(url: string, call: NetCallFn = bridgeCall, options: GetOptions = {}): Promise<T> {
  const res = await netHttp({ url, headers: { accept: 'application/json', ...options.headers } }, call, options.signal)
  if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, url)
  return JSON.parse(res.body) as T
}

/** 一个二进制响应 */
export interface BinaryResult {
  /** 内容 */
  blob: Blob
  /** 响应的 content-type，没有则为空串 */
  contentType: string
}

/**
 * base64 串解码成字节数组。
 *
 * @param b64 base64 文本
 * @returns 字节
 * @example base64ToBytes('aGk=') // Uint8Array [104, 105]
 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * GET 一个二进制资源（如图片）。非 2xx 抛 {@link HttpStatusError}；超过 2MB 被截断时抛 Error，避免拿到残缺文件。
 *
 * @param url 资源地址
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param options 请求头与取消信号
 * @returns Blob 与 content-type
 * @example const { blob } = await httpGetBase64('https://i0.hdslb.com/a.jpg')
 */
export async function httpGetBase64(url: string, call: NetCallFn = bridgeCall, options: GetOptions = {}): Promise<BinaryResult> {
  const res = await netHttp({ url, responseType: 'base64', headers: options.headers }, call, options.signal)
  if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, url)
  if (res.truncated) throw new Error('文件超过 2MB，无法获取')
  const contentType = res.headers['content-type'] ?? ''
  const blob = new Blob([base64ToBytes(res.body) as BlobPart], contentType ? { type: contentType.split(';')[0].trim() } : undefined)
  return { blob, contentType }
}
