// 抽取式摘要的纯逻辑：分句、相似度、TextRank 打分、按原文顺序取前 N 句

/** PageRank 阻尼系数 */
const DAMPING = 0.85
/** 最大迭代轮数 */
const MAX_ITER = 50
/** 收敛阈值：相邻两轮分数最大变化小于它就停 */
const EPSILON = 1e-6
/** 句子短于此字符数时视为噪声，不参与排名 */
const MIN_SENTENCE_LEN = 4
/** 最多参与排名的句子数，超出的只取前面的，防止 O(n²) 过慢 */
export const MAX_SENTENCES = 400

/**
 * 按中英文句末标点和换行分句，句末标点保留在句子里。
 *
 * @param text 原文
 * @returns 句子列表（已去首尾空白，去掉空句）
 * @example
 * splitSentences('今天晴。明天呢？') // ['今天晴。', '明天呢？']
 */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  // 句末标点（可连续，后面可跟收尾引号括号）或换行
  // 英文句点只有后面是空白或结尾才算句末，避免切坏小数和缩写
  const re = /(?:[^。！？!?；;.\n\r]|\.(?!\s|$))+(?:(?:[。！？!?；;]+|\.+(?=\s|$))[”’"')）」』】]*)?|(?:[。！？!?；;]+|\.+(?=\s|$))+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim()
    if (s) out.push(s)
  }
  return out
}

/**
 * 把句子拆成用于比较的词项：英文按词，中文按相邻两字（单字落单时取单字）。
 *
 * @param sentence 句子
 * @returns 词项集合
 * @example
 * Array.from(tokenizeForRank('天气好')) // ['天气', '气好']
 */
export function tokenizeForRank(sentence: string): Set<string> {
  const terms = new Set<string>()
  // 先抽英文/数字词
  const latin = sentence.toLowerCase().match(/[a-z0-9]+/g)
  if (latin) latin.forEach((w) => terms.add(w))
  // 再处理汉字连续段
  const runs = sentence.match(/[一-鿿]+/g)
  if (runs) {
    for (const run of runs) {
      if (run.length === 1) terms.add(run)
      for (let i = 0; i + 1 < run.length; i++) terms.add(run.slice(i, i + 2))
    }
  }
  return terms
}

/**
 * 两个词项集合的相似度：公共词数 / (log|A| + log|B|)，TextRank 论文里的做法。
 *
 * @param a 词项集合 A
 * @param b 词项集合 B
 * @returns 相似度，任一为空或太短时为 0
 * @example
 * similarity(new Set(['a', 'b']), new Set(['b', 'c'])) // 约 0.72
 */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let common = 0
  a.forEach((t) => {
    if (b.has(t)) common++
  })
  if (common === 0) return 0
  // 两句都只有 1 个词项时 log 为 0，用 1 兜底避免除零
  const denom = Math.log(a.size) + Math.log(b.size)
  return denom > 0 ? common / denom : 1
}

/**
 * 对相似度矩阵跑 PageRank，得到每个节点的分数。
 *
 * @param matrix 对称相似度矩阵（对角线忽略）
 * @returns 各节点分数，空矩阵返回空数组
 * @example
 * pageRank([[0, 1], [1, 0]]) // [0.5, 0.5]
 */
export function pageRank(matrix: readonly (readonly number[])[]): number[] {
  const n = matrix.length
  if (n === 0) return []
  const rowSum = matrix.map((row, i) => row.reduce((s, w, j) => (i === j ? s : s + w), 0))
  let score: number[] = new Array(n).fill(1 / n)
  for (let it = 0; it < MAX_ITER; it++) {
    const next: number[] = new Array(n)
    let delta = 0
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let j = 0; j < n; j++) {
        if (j === i || rowSum[j] === 0) continue
        sum += (matrix[j][i] / rowSum[j]) * score[j]
      }
      next[i] = (1 - DAMPING) / n + DAMPING * sum
      delta = Math.max(delta, Math.abs(next[i] - score[i]))
    }
    score = next
    if (delta < EPSILON) break
  }
  return score
}

/** 摘要结果 */
export interface SummaryResult {
  /** 摘要句子，保持原文顺序 */
  sentences: string[]
  /** 原文共分出几句 */
  total: number
}

/**
 * 生成抽取式摘要：分句 → 相似度图 → PageRank → 取分数最高的 N 句 → 按原文顺序排列。
 *
 * @param text 原文
 * @param n 想要几句（至少 1）；句子不够时返回全部
 * @returns 摘要与总句数
 * @throws RangeError n 不是正整数
 * @example
 * summarize('第一句。第二句。第三句。', 2).sentences
 */
export function summarize(text: string, n: number): SummaryResult {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('summarize: 句数要是正整数')
  const all = splitSentences(text)
  const sentences = all.slice(0, MAX_SENTENCES)
  // 太短的句子不参与排名，但要记住它们的原位置
  const idx = sentences.map((s, i) => i).filter((i) => sentences[i].length >= MIN_SENTENCE_LEN)
  const pool = idx.length ? idx : sentences.map((_s, i) => i)
  if (pool.length <= n) return { sentences: pool.map((i) => sentences[i]), total: all.length }

  const terms = pool.map((i) => tokenizeForRank(sentences[i]))
  const matrix = terms.map((a, x) => terms.map((b, y) => (x === y ? 0 : similarity(a, b))))
  const score = pageRank(matrix)
  const top = score
    .map((s, k) => ({ s, k }))
    // 分数相同时靠前的句子优先，保证结果稳定
    .sort((p, q) => q.s - p.s || p.k - q.k)
    .slice(0, n)
    .map((x) => x.k)
    .sort((p, q) => p - q)
  return { sentences: top.map((k) => sentences[pool[k]]), total: all.length }
}

/** 工具持久缓存的命名空间 */
export const TOOL_NS = 'summarize'
/** 最多可选摘要句数 */
export const MAX_N = 10

/**
 * 校验缓存的摘要句数：1 到 MAX_N 的整数。
 *
 * @param v 缓存值
 * @returns 合法返回 true
 */
export function isValidN(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_N
}
