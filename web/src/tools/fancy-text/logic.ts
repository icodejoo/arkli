// 花样文字的纯逻辑：用 Unicode 映射把文字转成上标、下标、小型大写、全角、圈号等样式

/** 花样样式 id */
export type FancyStyleId = 'superscript' | 'subscript' | 'smallcaps' | 'fullwidth' | 'circled' | 'circledBlack' | 'bold' | 'mathScript'

/** 一种花样 */
export interface FancyStyle {
  /** 样式 id */
  id: FancyStyleId
  /** 中文名 */
  label: string
  /** 字符映射表，没有的字符原样保留 */
  map: Readonly<Record<string, string>>
}

/**
 * 把两段等长字符串逐个配对成映射表。
 *
 * @param from 原字符序列
 * @param to 目标字符序列（按码点逐个对应）
 * @returns 映射表
 */
function pairs(from: string, to: string): Record<string, string> {
  const a = Array.from(from)
  const b = Array.from(to)
  const m: Record<string, string> = {}
  a.forEach((c, i) => {
    if (b[i] !== undefined && b[i] !== '') m[c] = b[i]
  })
  return m
}

/** 数字序列 */
const DIGITS = '0123456789'
/** 小写字母序列 */
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
/** 大写字母序列 */
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * 按连续码点区间生成一串字符，用于数学字母等连续块。
 *
 * @param start 起始码点
 * @param n 个数
 * @returns 字符串
 */
function range(start: number, n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCodePoint(start + i)
  return s
}

/** 上标：数字、符号与能表示的字母（q 没有对应上标，保持原样） */
const SUPERSCRIPT = pairs(
  DIGITS + '+-=()' + LOWER + 'ABDEGHIJKLMNOPRTUVW',
  '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾' + 'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖqʳˢᵗᵘᵛʷˣʸᶻ' + 'ᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ',
)

/** 下标：数字、符号与少量字母 */
const SUBSCRIPT = pairs(DIGITS + '+-=()' + 'aehijklmnoprstuvx', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎' + 'ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ')

/** 小型大写字母（英文转迷你大写 ᴀʙᴄ） */
const SMALLCAPS = pairs(LOWER, 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘqʀꜱᴛᴜᴠᴡxʏᴢ')

/** 全角：! 到 ~ 整体平移，空格换全角空格 */
const FULLWIDTH = (() => {
  const m: Record<string, string> = { ' ': '　' }
  for (let c = 0x21; c <= 0x7e; c++) m[String.fromCharCode(c)] = String.fromCharCode(c + 0xfee0)
  return m
})()

/** 带圈：数字 0-20 之外只做 0-9，字母 A-Z / a-z */
const CIRCLED = pairs(
  DIGITS + UPPER + LOWER,
  '⓪①②③④⑤⑥⑦⑧⑨' + range(0x24b6, 26) + range(0x24d0, 26),
)

/** 黑底带圈：字母 A-Z（大小写同形）与数字 1-9 */
const CIRCLED_BLACK = (() => {
  const m = pairs('123456789' + UPPER, '❶❷❸❹❺❻❼❽❾' + range(0x1f150, 26))
  Array.from(LOWER).forEach((c, i) => (m[c] = String.fromCodePoint(0x1f150 + i)))
  return m
})()

/** 数学粗体：字母 + 数字 */
const BOLD = pairs(UPPER + LOWER + DIGITS, range(0x1d400, 26) + range(0x1d41a, 26) + range(0x1d7ce, 10))

/** 数学手写体：字母（保留集里有空位的几个用 BMP 里的特殊码位） */
const MATH_SCRIPT = (() => {
  const upper = Array.from(range(0x1d49c, 26))
  const lower = Array.from(range(0x1d4b6, 26))
  // Unicode 里这几个手写体字母在 BMP 另有码位
  const holes: Record<string, string> = {
    B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ',
  }
  const m: Record<string, string> = {}
  Array.from(UPPER).forEach((c, i) => (m[c] = holes[c] ?? upper[i]))
  Array.from(LOWER).forEach((c, i) => (m[c] = holes[c] ?? lower[i]))
  return m
})()

/** 全部花样，页面按此顺序展示 */
export const FANCY_STYLES: readonly FancyStyle[] = [
  { id: 'superscript', label: '上标', map: SUPERSCRIPT },
  { id: 'subscript', label: '下标', map: SUBSCRIPT },
  { id: 'smallcaps', label: '小型大写', map: SMALLCAPS },
  { id: 'fullwidth', label: '全角', map: FULLWIDTH },
  { id: 'circled', label: '圈号', map: CIRCLED },
  { id: 'circledBlack', label: '黑底圈号', map: CIRCLED_BLACK },
  { id: 'bold', label: '粗体', map: BOLD },
  { id: 'mathScript', label: '手写体', map: MATH_SCRIPT },
]

/**
 * 用指定花样转换文字，映射表里没有的字符保持原样。
 *
 * @param text 原文
 * @param styleId 花样 id
 * @returns 转换结果
 * @throws RangeError 花样 id 不存在
 * @example
 * convertFancy('x2', 'superscript') // 'ˣ²'
 */
export function convertFancy(text: string, styleId: FancyStyleId): string {
  const style = FANCY_STYLES.find((s) => s.id === styleId)
  if (!style) throw new RangeError('convertFancy: 未知花样 ' + styleId)
  let out = ''
  for (const ch of text) {
    const v = Object.prototype.hasOwnProperty.call(style.map, ch) ? style.map[ch] : undefined
    out += v === undefined ? ch : v
  }
  return out
}

/**
 * 一次转出所有花样。
 *
 * @param text 原文
 * @returns 每种花样的 id、中文名与结果
 * @example
 * convertAll('a1').map((r) => r.text)
 */
export function convertAll(text: string): Array<{ id: FancyStyleId; label: string; text: string }> {
  return FANCY_STYLES.map((s) => ({ id: s.id, label: s.label, text: convertFancy(text, s.id) }))
}
