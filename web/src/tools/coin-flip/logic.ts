// 抛硬币：纯逻辑，先定结果再播动画
import { randomInt, type RandomSource, cryptoSource } from '@/shared/random'

/** 硬币面：正面 / 反面 */
export type CoinSide = 'heads' | 'tails'

/** 单次最多连抛次数 */
export const MAX_FLIPS = 20

/** 面的中文名 */
export const SIDE_LABEL: Record<CoinSide, string> = { heads: '正面', tails: '反面' }

/**
 * 抛一次硬币。
 *
 * @param src 随机源
 * @returns 'heads' 或 'tails'
 * @example
 * flipCoin() // 'heads'
 */
export function flipCoin(src: RandomSource = cryptoSource): CoinSide {
  return randomInt(0, 1, src) === 0 ? 'heads' : 'tails'
}

/**
 * 连抛 n 次。
 *
 * @param n 次数（1 ~ MAX_FLIPS）
 * @param src 随机源
 * @returns 每次的结果
 * @throws RangeError n 越界
 * @example
 * flipCoins(3) // ['heads', 'tails', 'tails']
 */
export function flipCoins(n: number, src: RandomSource = cryptoSource): CoinSide[] {
  if (!Number.isInteger(n) || n < 1 || n > MAX_FLIPS) throw new RangeError('次数越界')
  return Array.from({ length: n }, () => flipCoin(src))
}

/**
 * 统计正反面个数。
 *
 * @param results 结果列表
 * @returns 各面个数
 * @example
 * countSides(['heads', 'tails', 'heads']) // { heads: 2, tails: 1 }
 */
export function countSides(results: readonly CoinSide[]): Record<CoinSide, number> {
  const out: Record<CoinSide, number> = { heads: 0, tails: 0 }
  for (const r of results) out[r]++
  return out
}
