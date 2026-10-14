// 拆分选词的纯逻辑：中文分词（Intl.Segmenter，不支持时按字拆）与选中词拼接

/** 一个分词片段 */
export interface Token {
  /** 片段文本 */
  text: string
  /** 是否是词（标点、空白为 false，页面上不可选） */
  isWord: boolean
}

/** 分词器的最小接口，便于测试注入 */
export interface SegmenterLike {
  /** 对文本分段 */
  segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>
}

/** 匹配只含标点或空白的片段 */
const NON_WORD_RE = /^[\s\p{P}\p{S}]+$/u

/**
 * 创建中文分词器；环境不支持 Intl.Segmenter 时返回 null。
 *
 * @returns 分词器或 null
 * @example
 * const seg = createSegmenter()
 */
export function createSegmenter(): SegmenterLike | null {
  const Ctor = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => SegmenterLike })
    .Segmenter
  if (typeof Ctor !== 'function') return null
  try {
    return new Ctor('zh', { granularity: 'word' })
  } catch {
    return null
  }
}

/**
 * 把文本拆成片段；无分词器时按字（码点）拆。
 *
 * @param text 原文
 * @param seg 分词器，默认自动创建；传 null 强制按字拆
 * @returns 片段列表，拼起来等于原文
 * @example
 * tokenize('我爱北京', null).map((t) => t.text) // ['我', '爱', '北', '京']
 */
export function tokenize(text: string, seg: SegmenterLike | null = createSegmenter()): Token[] {
  if (!text) return []
  if (!seg) return Array.from(text).map((c) => ({ text: c, isWord: !NON_WORD_RE.test(c) }))
  const out: Token[] = []
  for (const s of seg.segment(text)) {
    const isWord = s.isWordLike !== undefined ? s.isWordLike : !NON_WORD_RE.test(s.segment)
    out.push({ text: s.segment, isWord })
  }
  return out
}

/**
 * 把选中的词按原顺序拼起来。
 *
 * @param tokens 全部片段
 * @param selected 选中的片段下标集合
 * @param sep 词与词之间的分隔符，默认空串
 * @returns 拼接结果，无选中时为空串
 * @example
 * joinSelected(tokenize('我爱你', null), new Set([0, 2])) // '我你'
 */
export function joinSelected(tokens: readonly Token[], selected: ReadonlySet<number>, sep = ''): string {
  const parts: string[] = []
  tokens.forEach((t, i) => {
    if (selected.has(i)) parts.push(t.text)
  })
  return parts.join(sep)
}

/**
 * 切换某个下标的选中状态，返回新集合（不改原集合）。
 *
 * @param selected 当前选中集合
 * @param index 要切换的下标
 * @returns 新集合
 * @example
 * toggleIndex(new Set([1]), 1) // Set {}
 */
export function toggleIndex(selected: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set(selected)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  return next
}

/**
 * 选中全部词（跳过标点空白）。
 *
 * @param tokens 全部片段
 * @returns 所有词的下标集合
 * @example
 * selectAllWords(tokenize('你好，', null)) // Set {0, 1}
 */
export function selectAllWords(tokens: readonly Token[]): Set<number> {
  const s = new Set<number>()
  tokens.forEach((t, i) => {
    if (t.isWord) s.add(i)
  })
  return s
}
