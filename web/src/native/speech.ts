/**
 * 本地流式语音转文字封装：查询可用性、开始/停止听写、订阅中间结果与定稿。
 * 对应原生 `native.speech.*` 与 `speech.partial` / `speech.final` 事件，契约见 docs/design/bridge-protocol.md「语音转文字方法」。
 *
 * 识别在本机完成（zipformer 流式模型），音频只在内存里，不落盘、不上传。
 * 无宿主时 {@link getSpeechStatus} 返回 `available: false`，其余函数抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall, isNativeAvailable, on as bridgeOn } from './bridge'
import { requireNative, type CallFn } from './system'
import type { OnFn } from './tts'

/** 方法名常量 */
export const SPEECH_METHODS = {
  status: 'native.speech.status',
  start: 'native.speech.start',
  stop: 'native.speech.stop',
} as const

/** 事件名常量 */
export const SPEECH_EVENTS = {
  partial: 'speech.partial',
  final: 'speech.final',
} as const

/** 引擎标识 */
export const SPEECH_ENGINE = 'local-zipformer'

/** 无宿主时的不可用原因 */
const REASON_NO_HOST = '当前不在 Arkli 容器内'

/** 语音转文字状态 */
export interface SpeechStatus {
  /** 是否可用：模型文件齐全且引擎库可加载 */
  available: boolean
  /** 引擎标识 */
  engine: string
  /** 模型文件是否齐全 */
  modelReady: boolean
  /** 不可用时的原因（中文） */
  reason?: string
}

/** 开始听写的入参 */
export interface SpeechStartOptions {
  /** 语言，目前只有 'zh-en'（中英混合），默认 'zh-en' */
  lang?: 'zh-en'
}

/**
 * 查询语音转文字是否可用。不会抛错：无宿主或调用失败都返回 `available: false`。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param hasHost 是否有宿主，默认探测 bridge（仅测试注入）
 * @returns 状态
 * @example if ((await getSpeechStatus()).available) showMic()
 */
export async function getSpeechStatus(call: CallFn = bridgeCall, hasHost: () => boolean = isNativeAvailable): Promise<SpeechStatus> {
  if (!hasHost()) return { available: false, engine: SPEECH_ENGINE, modelReady: false, reason: REASON_NO_HOST }
  try {
    return await call<SpeechStatus>(SPEECH_METHODS.status, {})
  } catch (e) {
    return { available: false, engine: SPEECH_ENGINE, modelReady: false, reason: speechErrorMessage(e) }
  }
}

/**
 * 开始听写。没有麦克风授权时原生会先申请；加载模型可能要几秒，期间不超时。
 * 失败码：`PERMISSION_DENIED`（权限被拒）、`NOT_READY`（模型缺失 / 已在听写 / 麦克风被占用）、`BAD_PARAMS`。
 *
 * @param opts 入参
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 采样率与后台任务号
 * @example await startSpeech({ lang: 'zh-en' })
 */
export async function startSpeech(opts: SpeechStartOptions = {}, call: CallFn = bridgeCall): Promise<{ sampleRate: number; taskId: string }> {
  requireNative(SPEECH_METHODS.start)
  const r = await call<{ started: boolean; sampleRate: number; taskId: string }>(SPEECH_METHODS.start, { ...opts }, { timeoutMs: 0 })
  return { sampleRate: r.sampleRate, taskId: r.taskId }
}

/**
 * 停止听写：冲刷剩余音频并释放麦克风；没在听写也可以调用。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 整段定稿文本
 * @example const { text } = await stopSpeech()
 */
export async function stopSpeech(call: CallFn = bridgeCall): Promise<{ text: string }> {
  requireNative(SPEECH_METHODS.stop)
  const r = await call<{ text: string }>(SPEECH_METHODS.stop, {})
  return { text: r.text ?? '' }
}

/**
 * 订阅中间结果：当前这句话的最新识别文本（会反复修正）。
 *
 * @param handler 收到文本时回调
 * @param on 事件订阅函数，默认走 bridge（仅测试注入）
 * @returns 取消订阅函数，组件卸载时务必调用
 * @example const off = onSpeechPartial((t) => (live.value = t))
 */
export function onSpeechPartial(handler: (text: string) => void, on: OnFn = bridgeOn as OnFn): () => void {
  return on(SPEECH_EVENTS.partial, (d) => handler(textOf(d)))
}

/**
 * 订阅一句话定稿：说完一句（检测到停顿）或停止时推送，之后该句不再变化。
 *
 * @param handler 收到定稿文本时回调
 * @param on 事件订阅函数，默认走 bridge（仅测试注入）
 * @returns 取消订阅函数，组件卸载时务必调用
 * @example const off = onSpeechFinal((t) => lines.push(t))
 */
export function onSpeechFinal(handler: (text: string) => void, on: OnFn = bridgeOn as OnFn): () => void {
  return on(SPEECH_EVENTS.final, (d) => handler(textOf(d)))
}

/**
 * 把调用失败翻译成给用户看的中文提示。
 *
 * @param e bridge 抛出的错误（`{ code, message }`）或其他异常
 * @returns 友好提示
 * @example showToast(speechErrorMessage(e))
 */
export function speechErrorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string } | null
  switch (err?.code) {
    case 'PERMISSION_DENIED':
      return '没有麦克风权限，请在系统设置里允许后再试'
    case 'NOT_READY':
      return err.message || '语音识别暂不可用'
    case 'BAD_PARAMS':
      return '语音识别参数有误'
    default:
      return err?.message || '语音识别出错了'
  }
}

/** 从事件数据里取 text 字段 */
function textOf(d: unknown): string {
  const t = (d as { text?: unknown } | null)?.text
  return typeof t === 'string' ? t : ''
}
