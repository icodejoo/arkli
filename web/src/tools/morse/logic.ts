// 摩斯电码：国际码表、文本与摩斯互转、播放时间线（点划与间隔按标准 1:3:7）

/** 点 */
export const DOT = '.'
/** 划 */
export const DASH = '-'
/** 字符之间的分隔（摩斯串里） */
export const LETTER_SEP = ' '
/** 单词之间的分隔（摩斯串里） */
export const WORD_SEP = '/'
/** 单位时长：点 1，划 3，符号内间隔 1，字符间隔 3，单词间隔 7 */
export const UNITS = { dot: 1, dash: 3, gap: 1, letterGap: 3, wordGap: 7 } as const
/** WPM 下限 */
export const WPM_MIN = 5
/** WPM 上限 */
export const WPM_MAX = 40
/** 音频频率下限（Hz） */
export const FREQ_MIN = 300
/** 音频频率上限（Hz） */
export const FREQ_MAX = 1000
/** 标准词 PARIS 共 50 个单位，WPM = 每分钟播多少个 PARIS */
const UNITS_PER_WORD = 50
/** 每分钟毫秒数 */
const MS_PER_MIN = 60000

/** 国际摩斯码表：字母、数字、常用标点 */
export const MORSE_TABLE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..',
  J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.',
  '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-',
  '+': '.-.-.', '-': '-....-', _: '..--.-', '"': '.-..-.', $: '...-..-', '@': '.--.-.',
}

/** 反查表：摩斯串 → 字符 */
const REVERSE: Record<string, string> = {}
for (const k of Object.keys(MORSE_TABLE)) REVERSE[MORSE_TABLE[k]] = k

/** 文本转摩斯的结果 */
export interface EncodeResult {
  /** 摩斯串：字符间用空格，单词间用 ` / ` */
  morse: string
  /** 不支持的字符（去重，保持出现顺序） */
  unsupported: string[]
  /** 是否含中文（用于提示“中文电码不支持”） */
  hasChinese: boolean
}

/** 判断是否为 CJK 汉字 */
function isChinese(ch: string): boolean {
  return /[㐀-鿿]/.test(ch)
}

/**
 * 文本转摩斯。大小写不敏感，空白当作单词分隔，不支持的字符跳过并记录。
 *
 * @param text 输入文本
 * @returns 摩斯串、不支持字符列表、是否含中文
 * @example
 * textToMorse('SOS') // { morse: '... --- ...', unsupported: [], hasChinese: false }
 */
export function textToMorse(text: string): EncodeResult {
  const unsupported: string[] = []
  let hasChinese = false
  const words: string[] = []
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue
    const codes: string[] = []
    for (const ch of Array.from(word)) {
      const code = MORSE_TABLE[ch.toUpperCase()]
      if (code) codes.push(code)
      else {
        if (isChinese(ch)) hasChinese = true
        if (!unsupported.includes(ch)) unsupported.push(ch)
      }
    }
    if (codes.length) words.push(codes.join(LETTER_SEP))
  }
  return { morse: words.join(` ${WORD_SEP} `), unsupported, hasChinese }
}

/** 摩斯转文本的结果 */
export interface DecodeResult {
  /** 解出的文本（大写，无法识别的码用 ? 占位） */
  text: string
  /** 无法识别的码 */
  unknown: string[]
}

/**
 * 摩斯转文本。字符间用空格，单词间用 `/`；也容忍 `·` `•` `－` `_` 等常见变体与多空格。
 *
 * @param morse 摩斯串
 * @returns 文本与无法识别的码
 * @example
 * morseToText('... --- ... / .-') // { text: 'SOS A', unknown: [] }
 */
export function morseToText(morse: string): DecodeResult {
  const unknown: string[] = []
  const norm = morse.replace(/[·•．。]/g, DOT).replace(/[－–—_]/g, DASH)
  const words = norm.trim().split(/\s*[/|]\s*/)
  const out: string[] = []
  for (const w of words) {
    const letters = w.trim().split(/\s+/).filter(Boolean)
    if (!letters.length) continue
    out.push(
      letters
        .map((code) => {
          const ch = REVERSE[code]
          if (ch) return ch
          if (!unknown.includes(code)) unknown.push(code)
          return '?'
        })
        .join(''),
    )
  }
  return { text: out.join(' '), unknown }
}

/**
 * 一个“单位”的毫秒数。
 *
 * @param wpm 每分钟字数（按 PARIS 标准），会限制在 WPM_MIN ~ WPM_MAX
 * @returns 单位时长（毫秒）
 * @example
 * unitMs(20) // 60
 */
export function unitMs(wpm: number): number {
  const w = Math.min(WPM_MAX, Math.max(WPM_MIN, Number.isFinite(wpm) ? wpm : WPM_MIN))
  return MS_PER_MIN / (w * UNITS_PER_WORD)
}

/** 时间线上的一段：响或静音 */
export interface Beep {
  /** 起始时间（毫秒，相对开头） */
  start: number
  /** 时长（毫秒） */
  duration: number
  /** true 为发声，false 为静音 */
  on: boolean
}

/**
 * 把摩斯串排成时间线：点 1、划 3、符号内间隔 1、字符间隔 3、单词间隔 7（单位）。
 * 相邻静音已合并，因此只有“响”段与其后的静音；末尾不留静音。
 *
 * @param morse 摩斯串（字符间空格，单词间 `/`）
 * @param wpm 每分钟字数
 * @returns 按时间顺序排列的响/静音段
 * @example
 * buildTimeline('.-', 20) // 点 60ms、间隔 60ms、划 180ms
 */
export function buildTimeline(morse: string, wpm: number): Beep[] {
  const u = unitMs(wpm)
  const out: Beep[] = []
  let t = 0
  /** 追加一段，静音与前一段静音合并 */
  const push = (units: number, on: boolean): void => {
    const d = units * u
    const last = out[out.length - 1]
    if (!on && last && !last.on) last.duration += d
    else out.push({ start: t, duration: d, on })
    t += d
  }
  const words = morse.trim().split(/\s*\/\s*/)
  words.forEach((w, wi) => {
    const letters = w.trim().split(/\s+/).filter(Boolean)
    letters.forEach((letter, li) => {
      Array.from(letter).forEach((sym, si) => {
        if (sym !== DOT && sym !== DASH) return
        if (si > 0) push(UNITS.gap, false)
        push(sym === DOT ? UNITS.dot : UNITS.dash, true)
      })
      if (li < letters.length - 1) push(UNITS.letterGap, false)
    })
    if (wi < words.length - 1 && letters.length) push(UNITS.wordGap, false)
  })
  // 去掉可能残留的末尾静音
  while (out.length && !out[out.length - 1].on) out.pop()
  return out
}

/**
 * 时间线总时长。
 *
 * @param timeline 时间线
 * @returns 总毫秒数（空时间线为 0）
 * @example
 * timelineDuration(buildTimeline('.', 20)) // 60
 */
export function timelineDuration(timeline: Beep[]): number {
  const last = timeline[timeline.length - 1]
  return last ? last.start + last.duration : 0
}
