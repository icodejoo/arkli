/**
 * 语音转文字的纯逻辑：识别结果的累积、可用性判断、导出文件名。
 * 不依赖 DOM 与原生，页面与单测共用。
 */
import { joinText } from '@/shared/voice-input'

/** 识别模型 id（与 models.json 一致） */
export const ASR_MODEL_ID = 'asr-zipformer-zh-en-mnn-w8'
/** 导出文件名前缀 */
export const EXPORT_PREFIX = 'speech'
/** 导出文件扩展名 */
export const EXPORT_EXT = '.txt'

/** 识别文本状态：已定稿的句子 + 当前这句的中间结果 */
export interface SttState {
  /** 已定稿的句子 */
  finals: string[]
  /** 当前这句的中间结果 */
  partial: string
}

/** 页面可用性结论 */
export type SttReadiness = 'ready' | 'no-model' | 'unavailable'

/**
 * 空状态。
 *
 * @returns 全新的状态对象
 * @example const s = emptySttState()
 */
export function emptySttState(): SttState {
  return { finals: [], partial: '' }
}

/**
 * 收到中间结果。
 *
 * @param s 当前状态
 * @param text 当前这句的最新文本
 * @returns 新状态
 * @example s = applySttPartial(s, '你好')
 */
export function applySttPartial(s: SttState, text: string): SttState {
  return { ...s, partial: text.trim() }
}

/**
 * 收到一句定稿：空白句只清中间结果。
 *
 * @param s 当前状态
 * @param text 本句定稿文本
 * @returns 新状态
 * @example s = applySttFinal(s, '你好。')
 */
export function applySttFinal(s: SttState, text: string): SttState {
  const t = text.trim()
  return { finals: t ? [...s.finals, t] : s.finals, partial: '' }
}

/**
 * 以停止时原生返回的整段文本为准收尾：整段为空则保留已有定稿，只清中间结果。
 *
 * @param s 当前状态
 * @param full stop 返回的整段文本
 * @returns 新状态
 * @example s = settleStt(s, text)
 */
export function settleStt(s: SttState, full: string): SttState {
  const t = full.trim()
  return t ? { finals: [t], partial: '' } : { finals: s.finals, partial: '' }
}

/**
 * 整段文本（含中间结果），句间按中英文边界拼接。
 *
 * @param s 当前状态
 * @returns 文本
 * @example transcriptText({ finals: ['你好。'], partial: 'hi' }) // '你好。hi'
 */
export function transcriptText(s: SttState): string {
  const done = s.finals.reduce(joinText, '')
  return s.partial ? joinText(done, s.partial) : done
}

/**
 * 是否还没有任何识别内容。
 *
 * @param s 当前状态
 * @returns 无内容为 true
 */
export function isSttEmpty(s: SttState): boolean {
  return !transcriptText(s).trim()
}

/**
 * 综合判断能否录音。
 *
 * @param modelInstalled 模型 store 里是否已安装
 * @param nativeAvailable 原生 status.available
 * @returns ready / no-model（先去下载）/ unavailable（引擎不可用）
 * @example speechReadiness(false, false) // 'no-model'
 */
export function speechReadiness(modelInstalled: boolean, nativeAvailable: boolean): SttReadiness {
  if (!modelInstalled) return 'no-model'
  return nativeAvailable ? 'ready' : 'unavailable'
}

/**
 * 生成导出文件名：speech-年月日-时分秒.txt。
 *
 * @param d 时间
 * @returns 文件名
 * @example exportFileName(new Date(2026, 0, 2, 3, 4, 5)) // 'speech-20260102-030405.txt'
 */
export function exportFileName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${EXPORT_PREFIX}-${date}-${time}${EXPORT_EXT}`
}

/**
 * 把秒数格式化成 mm:ss。
 *
 * @param sec 秒
 * @returns 文本
 * @example formatElapsed(65) // '01:05'
 */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
