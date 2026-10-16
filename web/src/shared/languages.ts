// 语言目录与选择规则（与具体页面无关）：全球主流语言、模型支持集合、语言对纠正
import type { AiOfferConstraints } from '@/native/ai'

/** 模型的语言约束：languages 省略或为 'all' 表示不限；sourceAuto 为真表示源语言可写 auto（原生报价的 constraints 即此形状） */
export type LangConstraints = Pick<AiOfferConstraints, 'sourceAuto'> & { languages?: readonly string[] | 'all' }

/** 源语言为 auto 换目标时优先选的语言 */
const PREFERRED_TGT = 'en'

/** 源/目标语言组合 */
export interface LangPair {
  /** 源语言码 */
  src: string
  /** 目标语言码 */
  tgt: string
}

/** 一种可选语言 */
export interface Lang {
  /** 应用语言码（BCP-47 风格） */
  code: string
  /** 显示名：用该语言自己的写法 */
  name: string
}

/** 全球主流语言目录，按常用度排序（即选择器的基础顺序）；各模型支持哪些由 registry 声明 */
export const LANGS: readonly Lang[] = [
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'ar', name: 'العربية' },
  { code: 'it', name: 'Italiano' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'th', name: 'ไทย' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'bn', name: 'বাংলা' },
  { code: 'ur', name: 'اردو' },
  { code: 'fa', name: 'فارسی' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'uk', name: 'Українська' },
  { code: 'cs', name: 'Čeština' },
  { code: 'sv', name: 'Svenska' },
  { code: 'da', name: 'Dansk' },
  { code: 'fi', name: 'Suomi' },
  { code: 'no', name: 'Norsk' },
  { code: 'el', name: 'Ελληνικά' },
  { code: 'he', name: 'עברית' },
  { code: 'hu', name: 'Magyar' },
  { code: 'ro', name: 'Română' },
  { code: 'bg', name: 'Български' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'fil', name: 'Filipino' },
  { code: 'sw', name: 'Kiswahili' },
  { code: 'ta', name: 'தமிழ்' },
  { code: 'te', name: 'తెలుగు' },
  { code: 'mr', name: 'मराठी' },
  { code: 'kk', name: 'Қазақша' },
]
/** 「自动检测」的语言码：只对源语言合法，表示不限制源语言由模型识别 */
export const AUTO_CODE = 'auto'
/** 「自动检测」选项（不在 {@link LANGS} 里，LANGS 只是可作目标的语言目录） */
export const AUTO_LANG: Lang = { code: AUTO_CODE, name: '自动检测' }
/** 自动检测在显示名里最多列出的语言个数，超出加「等」 */
export const AUTO_SHOW_MAX = 2

/** 是不是「自动检测」 */
export function isAuto(v: unknown): v is typeof AUTO_CODE {
  return v === AUTO_CODE
}

/** 是不是可作目标的语言代码（不含 auto） */
export function isLang(v: unknown): v is string {
  return LANGS.some((l) => l.code === v)
}

/** 是不是可作源的语言代码（目标可用语言，或 auto） */
export function isSourceLang(v: unknown): v is string {
  return isAuto(v) || isLang(v)
}

/**
 * 模型是否声明支持源语言自动检测。
 *
 * @param option 模型选项
 * @returns `sourceAuto` 为真时 true
 */
export function allowsAuto(option?: Pick<LangConstraints, 'sourceAuto'> | null): boolean {
  return !!option?.sourceAuto
}

/**
 * 源语言行的显示名：auto 且有识别结果时为「自动检测（English）」，多个用「、」连接，最多前 2 个再加「等」。
 *
 * @param src 源语言码
 * @param detected 最近一次翻译识别出的语言码，缺省为空
 * @returns 展示名；非 auto 时就是语言名
 * @example srcLabel('auto', ['en']) // '自动检测（English）'
 */
export function srcLabel(src: string, detected: readonly string[] = []): string {
  if (!isAuto(src)) return langName(src)
  if (!detected.length) return AUTO_LANG.name
  const shown = detected.slice(0, AUTO_SHOW_MAX).map((c) => langName(c))
  return `${AUTO_LANG.name}（${shown.join('、')}${detected.length > AUTO_SHOW_MAX ? '等' : ''}）`
}

/**
 * 取语言展示名。
 *
 * @param code 语言代码
 * @param languages 语言目录，缺省为全球目录
 * @returns 展示名；未知代码原样返回
 * @example langName('zh-CN') // '简体中文'
 */
export function langName(code: string, languages: readonly Lang[] = LANGS): string {
  return languages.find((l) => l.code === code)?.name ?? code
}

/** 一个选择器列项（vant picker 的选项形状） */
export interface LangColumn {
  /** 显示文字 */
  text: string
  /** 语言码 */
  value: string
  /** 当前模型不支持时为 true（置灰不可选） */
  disabled: boolean
}

/**
 * 当前模型选项支持的语言码集合，顺序同目录。
 *
 * @param option 模型选项；缺省或 `languages` 省略/'all' 表示不限语言
 * @returns 支持的语言码（目录内的）
 * @example supportedOf({ ...opt, languages: ['en', 'fr'] }) // ['en', 'fr']
 */
export function supportedOf(option?: Pick<LangConstraints, 'languages'> | null): string[] {
  const all = LANGS.map((l) => l.code)
  const langs = option?.languages
  if (!langs || langs === 'all') return all
  return all.filter((c) => langs.includes(c))
}

/**
 * 当前模型是否支持某语言。
 *
 * @param option 模型选项
 * @param code 语言码
 * @returns 支持为 true
 */
export function isSupported(option: Pick<LangConstraints, 'languages'> | null | undefined, code: string): boolean {
  return supportedOf(option).includes(code)
}

/**
 * 语言对里有不被支持的语言时，换成模型支持且两侧互不相同的语言。
 * 只有一侧不支持：保持另一侧不变，取支持集合里第一个不同于它的；两侧都不支持：取支持集合前两项；
 * 支持集合少于 2 种：原样返回（页面据此禁用翻译）。
 * 源为 auto：仅 `allowAuto` 为真时合法（与目标不冲突，只校验目标）；否则当作源不被支持处理。
 *
 * @param pair 当前组合
 * @param supported 当前模型支持的语言码
 * @param allowAuto 当前模型是否支持源自动检测，缺省 false
 * @returns 纠正后的组合
 * @example coercePair({ src: 'de', tgt: 'zh-CN' }, ['zh-CN', 'en']) // { src: 'en', tgt: 'zh-CN' }
 */
export function coercePair(pair: LangPair, supported: readonly string[], allowAuto = false): LangPair {
  if (supported.length < 2) return pair
  const autoSrc = isAuto(pair.src)
  const srcOk = autoSrc ? allowAuto : supported.includes(pair.src)
  const tgtOk = supported.includes(pair.tgt)
  if (srcOk && tgtOk) return pair
  if (srcOk) return { src: pair.src, tgt: supported.find((c) => c !== pair.src) as string }
  if (!tgtOk) return { src: supported[0], tgt: supported[1] }
  return { src: supported.find((c) => c !== pair.tgt) as string, tgt: pair.tgt }
}

/**
 * 生成选择器的列：当前模型支持的排前面，不支持的排后面并置灰（各自保持目录顺序）。
 *
 * @param supported 当前模型支持的语言码
 * @param languages 参与展示的语言目录，缺省为全球目录
 * @returns picker 列项
 */
export function buildColumns(supported: readonly string[], languages: readonly Lang[] = LANGS): LangColumn[] {
  const cols = languages.map((l) => ({ text: l.name, value: l.code, disabled: !supported.includes(l.code) }))
  return [...cols.filter((c) => !c.disabled), ...cols.filter((c) => c.disabled)]
}

/**
 * 在某一侧选语言。规则：选的语言与另一侧相同时，另一侧换成这一侧原来的语言（等价于交换），
 * 保证源与目标永远不同；传了 supported 时，不支持的语言被拒绝（原样返回），换过去的也必须被支持。
 * auto 只能选在源侧，且 `allowAuto` 为真；源为 auto 时目标不会因互斥被换掉。
 *
 * @param pair 当前组合
 * @param side 改哪一侧
 * @param code 选中的语言（源侧可为 auto）
 * @param supported 当前模型支持的语言码；缺省不限
 * @param allowAuto 当前模型是否支持源自动检测，缺省 false
 * @returns 新的组合
 * @example pickLang({ src: 'en', tgt: 'zh-CN' }, 'src', 'zh-CN') // { src: 'zh-CN', tgt: 'en' }
 */
export function pickLang(pair: LangPair, side: 'src' | 'tgt', code: string, supported?: readonly string[], allowAuto = false): LangPair {
  if (isAuto(code)) return side === 'src' && allowAuto ? { src: AUTO_CODE, tgt: pair.tgt } : pair
  if (supported && !supported.includes(code)) return pair
  const other = side === 'src' ? pair.tgt : pair.src
  const old = side === 'src' ? pair.src : pair.tgt
  const otherNew = other === code ? old : other
  const next: LangPair = side === 'src' ? { src: code, tgt: otherNew } : { src: otherNew, tgt: code }
  return supported ? coercePair(next, supported, allowAuto) : next
}

/**
 * 交换源与目标。源为 auto 时：新源 = 当前目标；新目标 = 最近识别出的第一个语言（须被支持且不同于新源），
 * 否则取支持集合里不同于新源的第一个（优先 en）。
 *
 * @param pair 当前组合
 * @param detected 最近一次翻译识别出的语言码
 * @param supported 当前模型支持的语言码
 * @returns 交换后的组合
 * @example swapLangs({ src: 'auto', tgt: 'zh-CN' }, ['fr'], ['zh-CN', 'fr']) // { src: 'zh-CN', tgt: 'fr' }
 */
export function swapLangs(pair: LangPair, detected: readonly string[], supported: readonly string[]): LangPair {
  if (!isAuto(pair.src)) return { src: pair.tgt, tgt: pair.src }
  const src = pair.tgt
  const first = detected[0]
  if (first && first !== src && supported.includes(first)) return { src, tgt: first }
  const pool = supported.filter((c) => c !== src)
  return { src, tgt: pool.includes(PREFERRED_TGT) ? PREFERRED_TGT : (pool[0] ?? src) }
}
