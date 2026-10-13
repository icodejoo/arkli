import { describe, expect, it } from 'vitest'
import { MAX_DICE, PIPS, rollDice } from './logic'

describe('rollDice', () => {
  it('点数在范围内且总和正确', () => {
    const r = rollDice(5, 20)
    expect(r.values).toHaveLength(5)
    expect(r.values.every((v) => v >= 1 && v <= 20)).toBe(true)
    expect(r.sum).toBe(r.values.reduce((a, b) => a + b, 0))
  })
  it('注入随机源可得到确定结果', () => {
    expect(rollDice(2, 6, () => 0)).toEqual({ values: [1, 1], sum: 2 })
    expect(rollDice(1, 100, () => 99).values).toEqual([100])
  })
  it('非法个数与面数抛错', () => {
    expect(() => rollDice(0, 6)).toThrow(RangeError)
    expect(() => rollDice(MAX_DICE + 1, 6)).toThrow(RangeError)
    expect(() => rollDice(1, 7)).toThrow(RangeError)
  })
  it('六面骰点阵点数与点位数一致', () => {
    for (let n = 1; n <= 6; n++) expect(PIPS[n]).toHaveLength(n)
  })
  it('六面骰大样本均匀', () => {
    const c = [0, 0, 0, 0, 0, 0]
    for (let i = 0; i < 12000; i++) c[rollDice(1, 6).values[0] - 1]++
    for (const n of c) expect(Math.abs(n - 2000)).toBeLessThan(250)
  })
})
