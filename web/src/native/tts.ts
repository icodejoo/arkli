/**
 * 文字转语音封装：朗读 / 停止 / 状态 / 保存为 wav。
 * 对应原生 `native.tts.*`，契约见 docs/design/bridge-protocol.md「文字转语音方法」。
 *
 * 无宿主时 speak / stop / status 退回浏览器 `speechSynthesis`（不支持则 status 为不可用、speak 抛
 * {@link NativeUnavailableError}）；save 只有原生能做，无宿主抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall, isNativeAvailable, on as bridgeOn } from './bridge'
import { NativeUnavailableError, type CallFn } from './system'

/** 方法名常量 */
export const TTS_METHODS = {
  speak: 'native.tts.speak',
  stop: 'native.tts.stop',
  status: 'native.tts.status',
  save: 'native.tts.save',
} as const

/** 事件名：朗读自然结束 */
export const TTS_EVENT_DONE = 'tts.done'
/** 事件名：朗读被打断 */
export const TTS_EVENT_STOPPED = 'tts.stopped'
/** 缺省语言 */
export const TTS_DEFAULT_LANG = 'zh-CN'

/** 朗读参数 */
export interface SpeakOptions {
  /** 文本，≤8000 字 */
  text: string
  /** 语言码，缺省 zh-CN */
  lang?: string
  /** 语速 0.5~2，缺省 1 */
  rate?: number
  /** 音调 0.5~2，缺省 1 */
  pitch?: number
}

/** 引擎状态 */
export interface TtsStatus {
  /** 引擎是否可用 */
  available: boolean
  /** 可用语言标签 */
  langs: string[]
}

/** 保存结果 */
export interface SavedSpeech {
  /** 缓存相对路径，可交给 `share` */
  path: string
  /** 文件名 */
  name: string
}

/** 朗读事件 */
export interface TtsEvent {
  /** 事件类型：done 读完，stopped 被打断 */
  type: 'done' | 'stopped'
  /** 朗读任务 id，对应 {@link speak} 的返回值 */
  id: string
  /** 是否因引擎出错而中断 */
  error?: boolean
}

/** 事件订阅函数形状，便于注入测试 */
export type OnFn = (event: string, handler: (data: unknown) => void) => () => void

/** 浏览器 speechSynthesis 的最小形状，便于注入测试 */
export interface BrowserSynth {
  /** 开始朗读一段 */
  speak(u: unknown): void
  /** 取消全部朗读 */
  cancel(): void
  /** 取可用音色 */
  getVoices(): Array<{ lang: string }>
}

/** 浏览器朗读语句的构造函数形状 */
export type UtteranceCtor = new (text: string) => {
  lang: string
  rate: number
  pitch: number
  onend: (() => void) | null
  onerror: (() => void) | null
}

/** 无宿主时本地事件的监听者 */
const localListeners = new Set<(e: TtsEvent) => void>()
/** 浏览器朗读的自增编号 */
let localSeq = 0
/** 当前浏览器朗读任务 id，被打断时用 */
let localActive: string | null = null

/** 推给本地监听者 */
function emitLocal(e: TtsEvent): void {
  localListeners.forEach((h) => h(e))
}

/** 取浏览器的 speechSynthesis，没有返回 null */
function browserSynth(): BrowserSynth | null {
  const g = globalThis as unknown as { speechSynthesis?: BrowserSynth }
  return g.speechSynthesis ?? null
}

/** 取浏览器的朗读语句构造函数 */
function browserUtterance(): UtteranceCtor | null {
  const g = globalThis as unknown as { SpeechSynthesisUtterance?: UtteranceCtor }
  return g.SpeechSynthesisUtterance ?? null
}

/**
 * 开始朗读，立即返回任务 id；读完或被打断通过 {@link onTtsEvent} 通知。会打断正在进行的朗读。
 *
 * 语言没有语音数据时以 NOT_READY 拒绝，请引导用户去系统设置 > 语言和输入法 > 文字转语音 安装。
 *
 * @param options 朗读参数
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 任务 id
 * @example const id = await speak({ text: '你好', rate: 1.2 })
 */
export async function speak(options: SpeakOptions, call: CallFn = bridgeCall): Promise<string> {
  if (!isNativeAvailable()) return speakInBrowser(options)
  const params: Record<string, unknown> = { text: options.text }
  if (options.lang !== undefined) params.lang = options.lang
  if (options.rate !== undefined) params.rate = options.rate
  if (options.pitch !== undefined) params.pitch = options.pitch
  const r = await call<{ id: string }>(TTS_METHODS.speak, params)
  return r.id
}

/** 浏览器朗读：不支持则抛 NativeUnavailableError */
function speakInBrowser(options: SpeakOptions, synth: BrowserSynth | null = browserSynth(), Utter: UtteranceCtor | null = browserUtterance()): string {
  if (!synth || !Utter) throw new NativeUnavailableError(TTS_METHODS.speak)
  if (localActive) emitLocal({ type: 'stopped', id: localActive })
  synth.cancel()
  const id = `b${++localSeq}`
  localActive = id
  const u = new Utter(options.text)
  u.lang = options.lang ?? TTS_DEFAULT_LANG
  u.rate = options.rate ?? 1
  u.pitch = options.pitch ?? 1
  u.onend = () => {
    if (localActive !== id) return
    localActive = null
    emitLocal({ type: 'done', id })
  }
  u.onerror = () => {
    if (localActive !== id) return
    localActive = null
    emitLocal({ type: 'stopped', id, error: true })
  }
  synth.speak(u)
  return id
}

/**
 * 停止朗读。没有在读时什么也不发生。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @example await stopSpeaking()
 */
export async function stopSpeaking(call: CallFn = bridgeCall): Promise<void> {
  if (!isNativeAvailable()) {
    const id = localActive
    localActive = null
    browserSynth()?.cancel()
    if (id) emitLocal({ type: 'stopped', id })
    return
  }
  await call(TTS_METHODS.stop)
}

/**
 * 查询引擎状态与可用语言。无宿主时看浏览器音色，不支持则 `available=false`。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 引擎状态
 * @example const { available, langs } = await ttsStatus()
 */
export async function ttsStatus(call: CallFn = bridgeCall): Promise<TtsStatus> {
  if (!isNativeAvailable()) {
    const synth = browserSynth()
    if (!synth || !browserUtterance()) return { available: false, langs: [] }
    const langs = Array.from(new Set(synth.getVoices().map((v) => v.lang.replace('_', '-')))).sort()
    return { available: true, langs }
  }
  return call<TtsStatus>(TTS_METHODS.status)
}

/**
 * 把文字合成为 wav 文件（不出声），之后可 `share`。文本不能超过引擎单次上限（通常约 4000 字），超了请分段。
 * 合成可能较慢，超时放宽到 2 分钟。
 *
 * @param options 合成参数
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 产物路径与文件名
 * @example const { path } = await saveSpeech({ text: '你好' })
 */
export async function saveSpeech(options: SpeakOptions, call: CallFn = bridgeCall): Promise<SavedSpeech> {
  if (!isNativeAvailable()) throw new NativeUnavailableError(TTS_METHODS.save)
  const params: Record<string, unknown> = { text: options.text }
  if (options.lang !== undefined) params.lang = options.lang
  if (options.rate !== undefined) params.rate = options.rate
  if (options.pitch !== undefined) params.pitch = options.pitch
  return call<SavedSpeech>(TTS_METHODS.save, params, { timeoutMs: SAVE_TIMEOUT_MS })
}

/** 保存音频的调用超时（毫秒） */
const SAVE_TIMEOUT_MS = 120_000

/**
 * 订阅朗读事件（读完 / 被打断）。无宿主时订阅的是浏览器朗读的本地事件。
 *
 * @param handler 事件回调
 * @param on 原生事件订阅函数，默认走 bridge（仅测试注入）
 * @returns 取消订阅函数，页面卸载时务必调用
 * @example const off = onTtsEvent((e) => { if (e.type === 'done') next() })
 */
export function onTtsEvent(handler: (e: TtsEvent) => void, on: OnFn = bridgeOn as OnFn): () => void {
  localListeners.add(handler)
  const toEvent = (type: TtsEvent['type']) => (data: unknown) => {
    const d = (data ?? {}) as { id?: string; error?: boolean }
    handler({ type, id: String(d.id ?? ''), ...(d.error ? { error: true } : {}) })
  }
  const offDone = on(TTS_EVENT_DONE, toEvent('done'))
  const offStopped = on(TTS_EVENT_STOPPED, toEvent('stopped'))
  return () => {
    localListeners.delete(handler)
    offDone()
    offStopped()
  }
}
