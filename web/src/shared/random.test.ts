import { describe, expect, it } from 'vitest'
import { cryptoSource, draw, pick, randomInt, shuffle, type RandomSource } from './random'

/** 按顺序吐出固定值的随机源 */
function seq(...vals: number[]): RandomSource {
  let i = 0
  return () => vals[i++ % vals.length]
}

describe('randomInt', () => {
  it('把 uint32 映射到区间内', () => {
    expect(randomInt(1, 6, seq(0))).toBe(1)
    expect(randomInt(1, 6, seq(5))).toBe(6)
    expect(randomInt(1, 6, seq(6))).toBe(1)
  })
  it('落在偏差区间时丢弃重抽', () => {
    // span=6 时 limit = 2^32 - 4，0xffffffff 与 limit 都应被拒绝
    const limit = 0x100000000 - (0x100000000 % 6)
    expect(randomInt(0, 5, seq(0xffffffff, limit, 3))).toBe(3)
  })
  it('单值区间恒返回该值', () => {
    expect(randomInt(7, 7, seq(123))).toBe(7)
  })
  it('非法区间抛错', () => {
    expect(() => randomInt(3, 2)).toThrow(RangeError)
    expect(() => randomInt(1.5, 3)).toThrow(RangeError)
    expect(() => randomInt(0, 2 ** 32)).toThrow(RangeError)
  })
  it('真实随机源大样本大致均匀', () => {
    const counts = [0, 0, 0, 0, 0, 0]
    const N = 60000
    for (let i = 0; i < N; i++) counts[randomInt(0, 5)]++
    for (const c of counts) expect(Math.abs(c - N / 6)).toBeLessThan((N / 6) * 0.1)
  })
})

describe('pick / shuffle / draw', () => {
  it('pick 空数组抛错，否则按下标取', () => {
    expect(() => pick([])).toThrow(RangeError)
    expect(pick(['a', 'b', 'c'], seq(1))).toBe('b')
  })
  it('shuffle 不改原数组且保留元素', () => {
    const src = [1, 2, 3, 4, 5]
    const out = shuffle(src)
    expect(src).toEqual([1, 2, 3, 4, 5])
    expect(out.slice().sort()).toEqual(src)
  })
  it('draw 不重复、越界抛错', () => {
    const out = draw([1, 2, 3, 4], 3)
    expect(new Set(out).size).toBe(3)
    expect(() => draw([1], 2)).toThrow(RangeError)
    expect(() => draw([1], 0)).toThrow(RangeError)
  })
  it('cryptoSource 返回 uint32', () => {
    const v = cryptoSource()
    expect(Number.isInteger(v) && v >= 0 && v < 2 ** 32).toBe(true)
  })
})
