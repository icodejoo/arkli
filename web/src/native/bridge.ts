import {
  METHOD_CANCEL,
  METHOD_HELLO,
  PROTOCOL_VERSION,
  type BridgeError,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeResponse,
  type NativeHello,
} from './protocol'

/** 默认调用超时（毫秒），超时后以 TIMEOUT 拒绝 */
const CALL_TIMEOUT_MS = 30_000

/** 原生侧注入的对象名，需与 ArkliBridge.JS_OBJECT_NAME 一致 */
const NATIVE_OBJECT_NAME = 'ArkliNative'

/** 原生侧（WebMessageListener）挂到 window 上的对象形状 */
interface NativeHost {
  /** 向原生投递一条字符串消息，只能发字符串 */
  postMessage(message: string): void
  /** 原生回传消息的回调，由本模块赋值 */
  onmessage: ((event: { data: unknown }) => void) | null
}

/** 单次调用的选项 */
export interface CallOptions {
  /** 超时毫秒数；0 表示不超时（长任务用），默认 30 秒 */
  timeoutMs?: number
  /** 取消信号；触发后向原生发 `native.task.cancel`，调用以 CANCELLED 拒绝 */
  signal?: AbortSignal
}

/** 等待响应的挂起请求 */
interface Pending {
  resolve: (data: unknown) => void
  reject: (error: BridgeError) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** 事件处理函数：data 为事件数据，sub 为订阅号（无则 undefined） */
export type EventHandler = (data: unknown, sub?: string) => void

/** 按请求编号挂起的调用表 */
const pendings = new Map<string, Pending>()

/** 事件订阅表：事件名 → 处理函数集合 */
const listeners = new Map<string, Set<EventHandler>>()

/** 自增序号，用于生成请求编号 */
let seq = 0

/** 握手结果缓存，同一页面只握手一次 */
let helloPromise: Promise<NativeHello> | null = null

/** 取原生宿主对象，不在 WebView 里（如浏览器调试）时返回 null */
function getHost(): NativeHost | null {
  const host = (window as unknown as Record<string, unknown>)[NATIVE_OBJECT_NAME]
  return host ? (host as NativeHost) : null
}

/** 生成一个新的请求编号 */
function nextId(): string {
  return `${Date.now().toString(36)}-${(seq++).toString(36)}`
}

/**
 * 调用原生/Rust 方法。
 *
 * @param method 方法名，格式 `域.模块.动作`
 * @param params 方法参数，默认空对象
 * @param options 超时与取消选项
 * @returns 方法返回的 data；失败时以 BridgeError 拒绝
 * @example
 * const { text } = await call<{ text: string }>('rust.ocr.recognize', { path: 'cache/in-001.png' })
 * // 长任务：不超时，可取消
 * const ac = new AbortController()
 * await call('native.video.compress', { src }, { timeoutMs: 0, signal: ac.signal })
 */
export function call<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<T> {
  const host = getHost()
  if (!host) {
    return Promise.reject<T>({ code: 'NOT_READY', message: '不在 Arkli 容器内' } satisfies BridgeError)
  }
  const { timeoutMs = CALL_TIMEOUT_MS, signal } = options
  if (signal?.aborted) {
    return Promise.reject<T>({ code: 'CANCELLED', message: `${method} 已取消` } satisfies BridgeError)
  }
  const id = nextId()
  const request: BridgeRequest = { v: PROTOCOL_VERSION, id, method, params }
  return new Promise<T>((resolve, reject) => {
    const settle = () => {
      const p = pendings.get(id)
      if (p?.timer) clearTimeout(p.timer)
      pendings.delete(id)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      // 只通知原生去取消；拒绝由原生回的 CANCELLED 响应触发，保证两边状态一致
      void call(METHOD_CANCEL, { id }).catch(() => undefined)
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            settle()
            reject({ code: 'TIMEOUT', message: `${method} 超时` } satisfies BridgeError)
          }, timeoutMs)
        : null
    pendings.set(id, {
      resolve: (data) => {
        settle()
        resolve(data as T)
      },
      reject: (error) => {
        settle()
        reject(error)
      },
      timer,
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      host.postMessage(JSON.stringify(request))
    } catch (e) {
      // 守卫脚本或通道异常会同步抛出，按 INTERNAL 拒绝
      settle()
      reject({ code: 'INTERNAL', message: String(e) } satisfies BridgeError)
    }
  })
}

/**
 * 握手：取原生的协议版本、会话号与能力字段，结果缓存。
 * 页面发二进制帧之前必须先看 `features.binary`。
 *
 * @returns 握手结果；不在容器内时以 NOT_READY 拒绝（并清缓存，允许重试）
 * @example
 * const { features } = await hello()
 * const mode = features.binary ? 'arraybuffer' : 'chunked-text'
 */
export function hello(): Promise<NativeHello> {
  if (!helloPromise) {
    helloPromise = call<NativeHello>(METHOD_HELLO).catch((e: BridgeError) => {
      helloPromise = null
      throw e
    })
  }
  return helloPromise
}

/**
 * 订阅原生事件。
 *
 * @param event 事件名，如 `download.progress`、`app.pause`
 * @param handler 事件处理函数，第二个参数是订阅号
 * @returns 取消订阅函数，页面卸载时务必调用
 */
export function on(event: string, handler: EventHandler): () => void {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(handler)
  return () => set.delete(handler)
}

/**
 * 原生回调入口：处理一条响应或事件消息。
 *
 * @param json 响应或事件的 JSON 字符串
 */
function dispatch(json: string): void {
  let msg: BridgeResponse | BridgeEvent
  try {
    msg = JSON.parse(json) as BridgeResponse | BridgeEvent
  } catch {
    return
  }
  if ('event' in msg) {
    listeners.get(msg.event)?.forEach((h) => h(msg.data, msg.sub))
    return
  }
  const pending = pendings.get(msg.id)
  if (!pending) return
  if (msg.ok) pending.resolve(msg.data)
  else pending.reject(msg.error)
}

/** 接上原生回传通道；不在容器内时什么也不做 */
function attach(): void {
  const host = getHost()
  if (!host) return
  host.onmessage = (event) => {
    if (typeof event.data === 'string') dispatch(event.data)
  }
}

attach()
