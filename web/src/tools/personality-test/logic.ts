// 十六型人格倾向测试：计分、边界处理、类型映射、结果文本（仅供娱乐）
import { DIMS, DIM_INFO, QUESTIONS, TYPES, type Dim, type TypeInfo } from './data'

/** 中立分（五级量表的中间值） */
export const NEUTRAL = 3
/** 单个维度满分绝对值（7 题 × 最大偏离 2） */
export const DIM_MAX = 14
/** 绝对分不超过它视为「接近中间」 */
export const BORDER_THRESHOLD = 2

/** 单个维度的结果 */
export interface DimResult {
  /** 维度 */
  dim: Dim
  /** 得分：正数偏 first 端，负数偏 second 端，范围 -14~14 */
  score: number
  /** 采用的字母 */
  letter: string
  /** 偏向 first 端的百分比（0~100） */
  percentFirst: number
  /** 是否正好各半（取了 second 端，仅为兜底） */
  tie: boolean
  /** 是否接近中间，结果不稳定 */
  borderline: boolean
}

/** 整体结果 */
export interface TestResult {
  /** 四个维度结果 */
  dims: DimResult[]
  /** 四字母类型码 */
  code: string
  /** 类型资料 */
  type: TypeInfo
  /** 是否有任一维度接近中间 */
  hasBorderline: boolean
}

/**
 * 已作答题数（只数 1~5 的整数）。
 *
 * @param answers 答案数组，未答用 0 或 undefined
 * @returns 已答题数
 * @example answeredCount([5, 0, 3]) // 2
 */
export function answeredCount(answers: ReadonlyArray<number | undefined>): number {
  return answers.filter((a) => Number.isInteger(a) && (a as number) >= 1 && (a as number) <= 5).length
}

/**
 * 算某一维度的得分：同意倾向 first 端为正，倾向 second 端为负，答「一般」不计分。
 *
 * @param dim 维度
 * @param answers 按题号排列的答案（1~5）
 * @returns 得分 -14~14
 * @example scoreDim('EI', Array(28).fill(3)) // 0
 */
export function scoreDim(dim: Dim, answers: ReadonlyArray<number | undefined>): number {
  const first = DIM_INFO[dim].first
  let sum = 0
  QUESTIONS.forEach((q, i) => {
    const a = answers[i]
    if (q.dim !== dim || !Number.isInteger(a) || (a as number) < 1 || (a as number) > 5) return
    const delta = (a as number) - NEUTRAL
    sum += q.agree === first ? delta : -delta
  })
  return sum
}

/**
 * 把维度得分转成结果：正偏 first，负偏 second，正好 0 时取 second 端并标记为 tie。
 *
 * @param dim 维度
 * @param score 得分
 * @returns 维度结果
 * @example dimResult('EI', 6).letter // 'E'
 */
export function dimResult(dim: Dim, score: number): DimResult {
  const info = DIM_INFO[dim]
  return {
    dim,
    score,
    letter: score > 0 ? info.first : info.second,
    percentFirst: Math.round(50 + (score / DIM_MAX) * 50),
    tie: score === 0,
    borderline: Math.abs(score) <= BORDER_THRESHOLD,
  }
}

/**
 * 按类型码查类型资料。
 *
 * @param code 四字母码
 * @returns 类型资料；不存在返回 undefined
 * @example typeByCode('ENTJ')?.name // '谋局者'
 */
export function typeByCode(code: string): TypeInfo | undefined {
  return TYPES.find((t) => t.code === code)
}

/**
 * 根据答案计算结果；有题没答时返回 null。
 *
 * @param answers 28 个答案（1~5）
 * @returns 结果；未答完返回 null
 * @example computeResult(Array(28).fill(5))?.code
 */
export function computeResult(answers: ReadonlyArray<number | undefined>): TestResult | null {
  if (answeredCount(answers.slice(0, QUESTIONS.length)) < QUESTIONS.length) return null
  const dims = DIMS.map((d) => dimResult(d, scoreDim(d, answers)))
  const code = dims.map((d) => d.letter).join('')
  const type = typeByCode(code)
  if (!type) return null
  return { dims, code, type, hasBorderline: dims.some((d) => d.borderline) }
}

/**
 * 生成可复制的结果文字。
 *
 * @param r 测试结果
 * @returns 多行文本，含类型、各维度倾向、描述和免责声明
 * @example formatResultText(result)
 */
export function formatResultText(r: TestResult): string {
  const lines = [`我的十六型人格倾向：${r.code} ${r.type.name}`, r.type.desc, `优点：${r.type.pros.join('；')}`, `短板：${r.type.cons.join('；')}`, '']
  for (const d of r.dims) {
    const info = DIM_INFO[d.dim]
    const pct = d.percentFirst
    lines.push(`${info.title}：${info.firstLabel} ${pct}% / ${info.secondLabel} ${100 - pct}%${d.borderline ? '（接近中间）' : ''}`)
  }
  lines.push('', '仅供娱乐，不构成心理评估。')
  return lines.join('\n')
}
