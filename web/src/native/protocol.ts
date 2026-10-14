/**
 * Bridge 协议类型，与 docs/design/bridge-protocol.md 保持一致。
 * 只放类型和常量，不含运行时逻辑。
 */

/** 当前协议版本，不兼容变更时递增 */
export const PROTOCOL_VERSION = 2

/** 错误码集合，与原生侧一致 */
export type BridgeErrorCode =
  | 'UNKNOWN_METHOD'
  | 'BAD_PARAMS'
  | 'PERMISSION_DENIED'
  | 'NOT_READY'
  | 'INTERNAL'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'NETWORK'
  | 'FORMAT_MISMATCH'

/** 页面发往原生的请求 */
export interface BridgeRequest {
  /** 协议版本 */
  v: number
  /** 请求编号，响应原样带回 */
  id: string
  /** 方法名，格式 `域.模块.动作`，如 `rust.ocr.recognize` */
  method: string
  /** 方法参数 */
  params: Record<string, unknown>
}

/** 失败详情 */
export interface BridgeError {
  /** 错误码 */
  code: BridgeErrorCode
  /** 给人看的简述 */
  message: string
}

/** 原生返回的响应，成功带 data，失败带 error */
export type BridgeResponse =
  | { v: number; id: string; ok: true; data: unknown }
  | { v: number; id: string; ok: false; error: BridgeError }

/** 原生主动推送的事件 */
export interface BridgeEvent {
  /** 协议版本 */
  v: number
  /** 事件名，如 `download.progress` */
  event: string
  /** 订阅号，订阅类方法返回的 `sub`，页面据此分流；无订阅的事件没有此字段 */
  sub?: string
  /** 事件数据 */
  data: unknown
}

/** `native.hello` 返回的能力字段 */
export interface NativeFeatures {
  /** 当前 WebView 是否支持 ArrayBuffer 消息；为 false 时只能发字符串帧，发 ArrayBuffer 会让 App 崩溃 */
  binary: boolean
}

/** `native.hello` 的返回值 */
export interface NativeHello {
  /** 原生支持的协议版本 */
  protocol: number
  /** 页面会话号，WebView 重载或崩溃重建后递增 */
  session: number
  /** 能力字段 */
  features: NativeFeatures
  /** 原生已注册的全部方法名（升序），页面据此探测某个能力是否存在；旧版原生没有此字段 */
  methods?: string[]
}

/** 内置取消方法名 */
export const METHOD_CANCEL = 'native.task.cancel'

/** 内置握手方法名 */
export const METHOD_HELLO = 'native.hello'

/** 生命周期事件：App 退到后台 */
export const EVENT_APP_PAUSE = 'app.pause'

/** 生命周期事件：App 回到前台 */
export const EVENT_APP_RESUME = 'app.resume'
