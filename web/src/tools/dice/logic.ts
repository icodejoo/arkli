// 掷骰子：纯逻辑
import { randomInt, type RandomSource, cryptoSource } from '@/shared/random'

/** 可选面数 */
export const SIDES_OPTIONS = [4, 6, 8, 10, 12, 20, 100] as const

/** 骰子个数范围 */
export const MIN_DICE = 1
export const MAX_DICE = 10

/** 一次投掷的结果 */
export interface RollResult {
  /** 每颗骰子的点数 */
  values: number[]
  /** 点数总和 */
  sum: number
}

/**
 * 掷若干颗骰子。
 *
 * @param count 骰子个数（1 ~ 10）
 * @param sides 面数（SIDES_OPTIONS 之一）
 * @param src 随机源
 * @returns 每颗点数与总和
 * @throws RangeError 个数或面数不合法
 * @example
 * rollDice(2, 6) // { values: [3, 5], sum: 8 }
 */
export function rollDice(count: number, sides: number, src: RandomSource = cryptoSource): RollResult {
  if (!Number.isInteger(count) || count < MIN_DICE || count > MAX_DICE) {
    throw new RangeError('骰子个数需在 1 ~ 10 之间')
  }
  if (!(SIDES_OPTIONS as readonly number[]).includes(sides)) throw new RangeError('不支持的面数')
  const values = Array.from({ length: count }, () => randomInt(1, sides, src))
  return { values, sum: values.reduce((a, b) => a + b, 0) }
}

/** 六面骰点阵：1 ~ 6 对应的 3x3 格子里亮起的位置（0 ~ 8，行优先） */
export const PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}
