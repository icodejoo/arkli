// 中文转拼音：基于 pinyin-pro（按需加载），这里只做选项映射与多音字提示

/** 声调写法：带声调符号 / 数字声调 / 无声调 */
export type ToneStyle = 'mark' | 'num' | 'none'

/** 输出样式：全拼 / 仅首字母 */
export type PinyinPattern = 'full' | 'first'

/** 转换选项 */
export interface PinyinOptions {
  /** 声调写法 */
  tone: ToneStyle
  /** 全拼或首字母 */
  pattern: PinyinPattern
  /** 保留非中文字符（字母、数字、标点），关掉则丢弃 */
  keepOther: boolean
  /** 拼音之间的分隔符，可为空串 */
  separator: string
  /** 姓氏模式：遇到"单""曾"等姓氏字优先读姓氏音 */
  surname: boolean
}

/** 默认选项 */
export const DEFAULT_OPTIONS: PinyinOptions = { tone: 'mark', pattern: 'full', keepOther: true, separator: ' ', surname: false }

/** 多音字提示 */
export interface PolyphonicHint {
  /** 汉字 */
  char: string
  /** 当前采用的读音（带声调符号） */
  current: string
  /** 全部读音（带声调符号） */
  all: string[]
}

/** 转换结果 */
export interface PinyinResult {
  /** 拼接好的拼音文本 */
  text: string
  /** 文本中出现的多音字（同一个字只列一次） */
  hints: PolyphonicHint[]
}

/** 输入字符数上限，再大词典匹配会卡 */
export const MAX_INPUT_CHARS = 20000

/** 用到的 pinyin-pro 接口子集，便于测试注入 */
export interface PinyinLib {
  pinyin: typeof import('pinyin-pro').pinyin
}

/** 声调选项到库参数的映射 */
const TONE_MAP: Record<ToneStyle, 'symbol' | 'num' | 'none'> = { mark: 'symbol', num: 'num', none: 'none' }

/**
 * 按需加载 pinyin-pro（含词典，较大，首次点转换才调用）。
 *
 * @returns 库对象
 */
export async function loadPinyin(): Promise<PinyinLib> {
  const m = await import('pinyin-pro')
  return { pinyin: m.pinyin }
}

/**
 * 把文本转成拼音。
 *
 * @param lib 已加载的 pinyin-pro
 * @param text 输入文本
 * @param opts 转换选项
 * @returns 拼音文本与多音字提示；输入超长时抛 RangeError
 * @example
 * convertPinyin(lib, '你好', { ...DEFAULT_OPTIONS, tone: 'none' }).text // 'ni hao'
 */
export function convertPinyin(lib: PinyinLib, text: string, opts: PinyinOptions): PinyinResult {
  if (text.length > MAX_INPUT_CHARS) throw new RangeError(`内容太长了（超过 ${MAX_INPUT_CHARS} 字），请分段转换`)
  if (!text) return { text: '', hints: [] }
  const common = {
    toneType: TONE_MAP[opts.tone],
    pattern: opts.pattern === 'first' ? ('first' as const) : ('pinyin' as const),
    nonZh: opts.keepOther ? ('consecutive' as const) : ('removed' as const),
    ...(opts.surname ? { mode: 'surname' as const } : {}),
  }
  const parts = lib.pinyin(text, { ...common, type: 'array' })
  // 全拼模式下英文数字连续保留，首字母模式下同样原样保留
  const out = parts.join(opts.separator)
  return { text: out, hints: collectHints(lib, text, opts.surname) }
}

/** 收集文本里的多音字：取库给出的全部读音，同一个字只记一次 */
function collectHints(lib: PinyinLib, text: string, surname: boolean): PolyphonicHint[] {
  const all = lib.pinyin(text, { type: 'all', ...(surname ? { mode: 'surname' as const } : {}) })
  const seen = new Set<string>()
  const hints: PolyphonicHint[] = []
  for (const item of all) {
    if (!item.isZh || item.polyphonic.length < 2 || seen.has(item.origin)) continue
    seen.add(item.origin)
    hints.push({ char: item.origin, current: item.pinyin, all: item.polyphonic })
  }
  return hints
}
