// 查字：读音（pinyin-pro，按需加载）、Unicode 码点、UTF-8 / UTF-16 字节、所在区段。
// 部首、笔画、释义没有可用的数据来源，这里不做；简繁也不转换。

/** 一次最多查多少个不同的字，再多列表太长 */
export const MAX_CHARS = 50

/** 码点十六进制至少补到几位（U+4E00 这种写法） */
const MIN_HEX_DIGITS = 4
/** UTF-8 / UTF-16 字节之间的分隔符 */
const BYTE_SEP = ' '
/** 汉字所在的 Unicode 区段，按起点排序；label 用于展示 */
const HAN_RANGES: ReadonlyArray<{ from: number; to: number; label: string; basic: boolean }> = [
  { from: 0x2e80, to: 0x2fdf, label: '部首补充 / 康熙部首', basic: false },
  { from: 0x3400, to: 0x4dbf, label: '扩展 A 区', basic: false },
  { from: 0x4e00, to: 0x9fff, label: '基本区', basic: true },
  { from: 0xf900, to: 0xfaff, label: '兼容汉字区', basic: false },
  { from: 0x20000, to: 0x2a6df, label: '扩展 B 区', basic: false },
  { from: 0x2a700, to: 0x2b73f, label: '扩展 C 区', basic: false },
  { from: 0x2b740, to: 0x2b81f, label: '扩展 D 区', basic: false },
  { from: 0x2b820, to: 0x2ceaf, label: '扩展 E 区', basic: false },
  { from: 0x2ceb0, to: 0x2ebef, label: '扩展 F 区', basic: false },
  { from: 0x2f800, to: 0x2fa1f, label: '兼容汉字补充区', basic: false },
  { from: 0x30000, to: 0x3134f, label: '扩展 G 区', basic: false },
  { from: 0x31350, to: 0x323af, label: '扩展 H 区', basic: false },
]

/** 所在区段信息 */
export interface HanRange {
  /** 是否属于汉字相关区段 */
  han: boolean
  /** 是否在基本区（U+4E00–9FFF，常用字都在这里） */
  basic: boolean
  /** 区段名；非汉字为「非汉字」 */
  label: string
}

/** 三种写法的读音 */
export interface Readings {
  /** 带声调符号，如 cháng */
  mark: string[]
  /** 数字声调，如 chang2 */
  num: string[]
  /** 无声调，如 chang */
  none: string[]
}

/** 单个字的查询结果 */
export interface CharInfo {
  /** 字本身（可能是增补平面的两个 UTF-16 单元） */
  char: string
  /** Unicode 码点，如 `U+4E00` */
  unicode: string
  /** UTF-8 字节（十六进制，空格分隔） */
  utf8: string
  /** UTF-16 码元（十六进制，空格分隔） */
  utf16: string
  /** 区段 */
  range: HanRange
  /** 读音；非汉字为空数组 */
  readings: Readings
}

/** 用到的 pinyin-pro 接口子集，便于测试注入 */
export interface PinyinLib {
  /** pinyin-pro 的 pinyin 函数 */
  pinyin: typeof import('pinyin-pro').pinyin
}

/**
 * 按需加载 pinyin-pro（含词典，较大，首次查字才调用）。
 *
 * @returns 库对象
 * @example
 * const lib = await loadPinyin()
 */
export async function loadPinyin(): Promise<PinyinLib> {
  const m = await import('pinyin-pro')
  return { pinyin: m.pinyin }
}

/**
 * 把输入拆成不重复的单个字（按码点拆，增补平面字符与 emoji 不会被劈开），丢掉空白。
 *
 * @param text 用户输入
 * @param max 最多保留几个，默认 {@link MAX_CHARS}
 * @returns chars 为去重后的字，truncated 表示超出上限被截断
 * @example
 * splitChars('你 好你') // { chars: ['你', '好'], truncated: false }
 */
export function splitChars(text: string, max = MAX_CHARS): { chars: string[]; truncated: boolean } {
  const seen = new Set<string>()
  const chars: string[] = []
  let truncated = false
  for (const ch of Array.from(text)) {
    if (/\s/.test(ch) || seen.has(ch)) continue
    if (chars.length >= max) {
      truncated = true
      break
    }
    seen.add(ch)
    chars.push(ch)
  }
  return { chars, truncated }
}

/**
 * 取第一个字的码点。
 *
 * @param ch 单个字
 * @returns 码点；空串返回 -1
 */
function codePointOf(ch: string): number {
  return ch.codePointAt(0) ?? -1
}

/**
 * 字节转两位大写十六进制。
 *
 * @param n 0~255
 * @returns 如 `0A`
 */
function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * 码点写成 `U+XXXX`（至少 4 位大写十六进制）。
 *
 * @param ch 单个字
 * @returns 如 `U+4E00`、`U+20BB7`
 * @example
 * unicodeOf('𠮷') // 'U+20BB7'
 */
export function unicodeOf(ch: string): string {
  return `U+${codePointOf(ch).toString(16).toUpperCase().padStart(MIN_HEX_DIGITS, '0')}`
}

/**
 * UTF-8 字节，十六进制空格分隔。
 *
 * @param ch 单个字
 * @returns 如 `E4 B8 80`
 * @example
 * utf8Of('一') // 'E4 B8 80'
 */
export function utf8Of(ch: string): string {
  return Array.from(new TextEncoder().encode(ch), hex2).join(BYTE_SEP)
}

/**
 * UTF-16 码元（大端），十六进制空格分隔；增补平面字符是一对代理项。
 *
 * @param ch 单个字
 * @returns 如 `4E00`、`D842 DFB7`
 * @example
 * utf16Of('𠮷') // 'D842 DFB7'
 */
export function utf16Of(ch: string): string {
  const units: string[] = []
  for (let i = 0; i < ch.length; i++) units.push(ch.charCodeAt(i).toString(16).toUpperCase().padStart(MIN_HEX_DIGITS, '0'))
  return units.join(BYTE_SEP)
}

/**
 * 判断字所在的 Unicode 区段。
 *
 * @param ch 单个字
 * @returns han 是否汉字区段、basic 是否基本区、label 区段名
 * @example
 * rangeOf('𠮷') // { han: true, basic: false, label: '扩展 B 区' }
 */
export function rangeOf(ch: string): HanRange {
  const cp = codePointOf(ch)
  const hit = HAN_RANGES.find((r) => cp >= r.from && cp <= r.to)
  return hit ? { han: true, basic: hit.basic, label: hit.label } : { han: false, basic: false, label: '非汉字' }
}

/**
 * 去重并保持顺序。
 *
 * @param list 字符串数组
 * @returns 去重后的新数组
 */
function uniq(list: readonly string[]): string[] {
  return list.filter((v, i) => list.indexOf(v) === i)
}

/**
 * 查一个字的全部读音，三种写法各一份（多音字全列，写法转换后重复的会合并）。
 *
 * @param lib 已加载的 pinyin-pro
 * @param ch 单个字
 * @returns 读音；非汉字区段返回空数组
 * @example
 * readingsOf(lib, '长').mark // ['cháng', 'zhǎng']
 */
export function readingsOf(lib: PinyinLib, ch: string): Readings {
  if (!rangeOf(ch).han) return { mark: [], num: [], none: [] }
  /** 取某种写法的读音，库没认出来（原样返回）按没有处理 */
  const get = (toneType: 'symbol' | 'num' | 'none'): string[] => {
    const r = lib.pinyin(ch, { multiple: true, type: 'array', toneType }) as string[]
    return uniq(r.filter((s) => s !== ch))
  }
  return { mark: get('symbol'), num: get('num'), none: get('none') }
}

/**
 * 查一个字的全部信息。
 *
 * @param lib 已加载的 pinyin-pro
 * @param ch 单个字
 * @returns 码点、字节、区段、读音
 * @example
 * lookupChar(lib, '一').unicode // 'U+4E00'
 */
export function lookupChar(lib: PinyinLib, ch: string): CharInfo {
  return { char: ch, unicode: unicodeOf(ch), utf8: utf8Of(ch), utf16: utf16Of(ch), range: rangeOf(ch), readings: readingsOf(lib, ch) }
}

/**
 * 把一个字的查询结果整理成可复制的多行文本。
 *
 * @param info 查询结果
 * @returns 多行文本，没有读音时省略读音行
 * @example
 * infoToText(lookupChar(lib, '一')).split('\n')[0] // '一'
 */
export function infoToText(info: CharInfo): string {
  const lines = [info.char]
  if (info.readings.mark.length) lines.push(`读音：${info.readings.mark.join('、')}（${info.readings.num.join('、')}）`)
  lines.push(`Unicode：${info.unicode}（${info.range.label}）`)
  lines.push(`UTF-8：${info.utf8}`)
  lines.push(`UTF-16：${info.utf16}`)
  return lines.join('\n')
}
