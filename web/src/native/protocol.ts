/**
 * Bridge 协议类型，与 docs/design/bridge-protocol.md 保持一致。
 * 只放类型和常量，不含运行时逻辑。
 */

/** 当前协议版本，不兼容变更时递增 */
export const PROTOCOL_VERSION = 1

/** 错误码集合，与原生侧一致 */
export type BridgeErrorCode =
  | 'UNKNOWN_METHOD'
  | 'BAD_PARAMS'
  | 'PERMISSION_DENIED'
  | 'NOT_READY'
  | 'INTERNAL'
  | 'TIMEOUT'

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
  /** 事件数据 */
  data: unknown
}
