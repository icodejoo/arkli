/**
 * 语音输入的文本状态：把「听写前已有文本」与「定稿句 + 当前中间结果」合并成输入框内容。
 * 纯函数，不依赖 DOM 与原生，供 VoiceInput.vue 使用并单测。
 */

/** 听写过程中的文本状态 */
export interface DictationState {
  /** 开始听写时输入框里已有的文本（听写结果追加在它后面） */
  base: string
  /** 已定稿的句子拼接 */
  finals: string
  /** 当前这句的中间结果 */
  partial: string
}

/** 是否 ASCII 字母数字 */
function isAlnum(ch: string): boolean {
  return /^[A-Za-z0-9]$/.test(ch)
}

/**
 * 拼接两段文本：交界处两侧都是字母数字时补一个空格，其余直接相接。
 *
 * @param a 前段
 * @param b 后段
 * @returns 拼接结果
 * @example joinText('你好', 'world') // '你好world'；joinText('hello', 'world') // 'hello world'
 */
export function joinText(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  return isAlnum(a[a.length - 1]) && isAlnum(b[0]) ? `${a} ${b}` : a + b
}

/**
 * 开始一次听写：记下已有文本。
 *
 * @param current 输入框当前文本
 * @returns 初始状态
 */
export function startDictation(current: string): DictationState {
  return { base: current, finals: '', partial: '' }
}

/**
 * 收到中间结果。
 *
 * @param s 当前状态
 * @param text 当前这句的最新文本
 * @returns 新状态
 */
export function applyPartial(s: DictationState, text: string): DictationState {
  return { ...s, partial: text.trim() }
}

/**
 * 收到一句定稿：并入定稿文本并清空中间结果；空白句只清中间结果。
 *
 * @param s 当前状态
 * @param text 本句定稿文本
 * @returns 新状态
 */
export function applyFinal(s: DictationState, text: string): DictationState {
  const t = text.trim()
  return { ...s, finals: t ? joinText(s.finals, t) : s.finals, partial: '' }
}

/**
 * 听写中用户自己改了输入框：以新文本为基准，之前的定稿与中间结果不再重复追加。
 *
 * @param s 当前状态
 * @param value 用户改后的文本
 * @returns 新状态
 */
export function rebase(s: DictationState, value: string): DictationState {
  return { base: value, finals: '', partial: s.partial }
}

/**
 * 当前应显示的整段文本。
 *
 * @param s 当前状态
 * @returns 已有文本 + 定稿 + 中间结果
 */
export function dictationText(s: DictationState): string {
  return joinText(joinText(s.base, s.finals), s.partial)
}

/**
 * 按最大长度截断；max 为空或非正数时不截断。
 *
 * @param text 文本
 * @param max 最大长度（可为字符串数字，来自 maxlength 属性）
 * @returns 截断后的文本
 */
export function clampLength(text: string, max: number | string | undefined): string {
  const n = Number(max)
  return Number.isFinite(n) && n > 0 && text.length > n ? text.slice(0, n) : text
}
