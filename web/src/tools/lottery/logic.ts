// 自定义抽签：纯逻辑，选项解析见 shared/options
import { draw, type RandomSource, cryptoSource } from '@/shared/random'

/** 抽签校验结果：error 为空表示可抽 */
export interface DrawCheck {
  /** 错误提示；通过时为 null */
  error: string | null
}

/**
 * 校验选项与抽取数量。
 *
 * @param items 选项列表
 * @param count 抽取个数
 * @returns 通过时 error 为 null，否则给出中文提示
 * @example
 * checkDraw(['a'], 2).error // '抽取数量不能超过选项数'
 */
export function checkDraw(items: readonly string[], count: number): DrawCheck {
  if (items.length < 2) return { error: '至少需要 2 个选项' }
  if (!Number.isInteger(count) || count < 1) return { error: '抽取数量至少为 1' }
  if (count > items.length) return { error: '抽取数量不能超过选项数' }
  return { error: null }
}

/**
 * 不放回抽签。
 *
 * @param items 选项列表
 * @param count 抽取个数
 * @param src 随机源
 * @returns 中签项，按抽中顺序
 * @throws RangeError 校验不通过
 * @example
 * drawLots(['甲', '乙', '丙'], 1) // ['乙']
 */
export function drawLots(items: readonly string[], count: number, src: RandomSource = cryptoSource): string[] {
  const { error } = checkDraw(items, count)
  if (error) throw new RangeError(error)
  return draw(items, count, src)
}
