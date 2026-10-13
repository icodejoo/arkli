import { describe, expect, it } from 'vitest'
import { countSides, flipCoin, flipCoins, MAX_FLIPS } from './logic'

describe('flipCoin', () => {
  it('随机源偶数为正面、奇数为反面', () => {
    expect(flipCoin(() => 0)).toBe('heads')
    expect(flipCoin(() => 1)).toBe('tails')
  })
})

describe('flipCoins', () => {
  it('返回指定次数', () => {
    expect(flipCoins(5)).toHaveLength(5)
    expect(flipCoins(3, () => 1)).toEqual(['tails', 'tails', 'tails'])
  })
  it('次数非法抛错', () => {
    expect(() => flipCoins(0)).toThrow(RangeError)
    expect(() => flipCoins(MAX_FLIPS + 1)).toThrow(RangeError)
    expect(() => flipCoins(1.5)).toThrow(RangeError)
  })
  it('大样本接近五五开', () => {
    const c = countSides(Array.from({ length: 20000 }, () => flipCoin()))
    expect(Math.abs(c.heads - 10000)).toBeLessThan(500)
  })
})

describe('countSides', () => {
  it('统计个数，空列表为 0', () => {
    expect(countSides(['heads', 'tails', 'heads'])).toEqual({ heads: 2, tails: 1 })
    expect(countSides([])).toEqual({ heads: 0, tails: 0 })
  })
})
