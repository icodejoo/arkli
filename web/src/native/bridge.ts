import {
  PROTOCOL_VERSION,
  type BridgeError,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeResponse,
} from './protocol'

/** 调用超时（毫秒），超时后以 TIMEOUT 拒绝 */
const CALL_TIMEOUT_MS = 30_000

/** 原生侧注入的对象名，需与 ArkliBridge 的注册名一致 */
const NATIVE_OBJECT_NAME = 'ArkliNative'

/** 原生侧挂到 window 上的对象形状 */
interface NativeHost {
  /** 向原生投递一条 JSON 消息 */
  postMessage(json: string): void
}

/** 等待响应的挂起请求 */
interface Pending {
  resolve: (data: unknown) => void
  reject: (error: BridgeError) => void
  timer: ReturnType<typeof setTimeout>
}

/** 按请求编号挂起的调用表 */
const pendings = new Map<string, Pending>()

/** 事件订阅表：事件名 → 处理函数集合 */
const listeners = new Map<string, Set<(data: unknown) => void>>()

/** 自增序号，用于生成请求编号 */
let seq = 0

/** 取原生宿主对象，不在 WebView 里（如浏览器调试）时返回 null */
function getHost(): NativeHost | null {
  const host = (window as unknown as Record<string, unknown>)[NATIVE_OBJECT_NAME]
  return host ? (host as NativeHost) : null
}

/**
 * 调用原生/Rust 方法。
 *
 * @param method 方法名，格式 `域.模块.动作`
 * @param params 方法参数，默认空对象
 * @returns 方法返回的 data；失败时以 BridgeError 拒绝
 * @example
 * const { text } = await call<{ text: string }>('rust.ocr.recognize', { path: 'cache/in-001.png' })
 */
export function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const host = getHost()
  if (!host) {
    return Promise.reject<T>({ code: 'NOT_READY', message: '不在 Arkli 容器内' } satisfies BridgeError)
  }
  const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`
  const request: BridgeRequest = { v: PROTOCOL_VERSION, id, method, params }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendings.delete(id)
      reject({ code: 'TIMEOUT', message: `${method} 超时` } satisfies BridgeError)
    }, CALL_TIMEOUT_MS)
    pendings.set(id, { resolve: resolve as (data: unknown) => void, reject, timer })
    host.postMessage(JSON.stringify(request))
  })
}

/**
 * 订阅原生事件。
 *
 * @param event 事件名，如 `download.progress`
 * @param handler 事件处理函数
 * @returns 取消订阅函数，页面卸载时务必调用
 */
export function on(event: string, handler: (data: unknown) => void): () => void {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(handler)
  return () => set.delete(handler)
}

/**
 * 原生回调入口：原生通过 evaluateJavascript 调用 `window.__arkliDispatch(json)`。
 *
 * @param json 响应或事件的 JSON 字符串
 */
function dispatch(json: string): void {
  const msg = JSON.parse(json) as BridgeResponse | BridgeEvent
  if ('event' in msg) {
    listeners.get(msg.event)?.forEach((h) => h(msg.data))
    return
  }
  const pending = pendings.get(msg.id)
  if (!pending) return
  pendings.delete(msg.id)
  clearTimeout(pending.timer)
  if (msg.ok) pending.resolve(msg.data)
  else pending.reject(msg.error)
}

;(window as unknown as Record<string, unknown>).__arkliDispatch = dispatch
