import { describe, expect, it } from 'vitest'
import { bmiLevel, calcBmi, calcBmr, calcTdee, normalWeightRange } from './logic'

describe('calcBmi / bmiLevel', () => {
  it('计算', () => {
    expect(calcBmi(170, 65)).toBe(22.5)
    expect(calcBmi(0, 65)).toBeNull()
    expect(calcBmi(170, -1)).toBeNull()
  })
  it('分级边界', () => {
    expect(bmiLevel(18.4)).toBe('偏瘦')
    expect(bmiLevel(18.5)).toBe('正常')
    expect(bmiLevel(23.9)).toBe('正常')
    expect(bmiLevel(24)).toBe('超重')
    expect(bmiLevel(27.9)).toBe('超重')
    expect(bmiLevel(28)).toBe('肥胖')
  })
  it('正常体重区间', () => {
    expect(normalWeightRange(170)).toEqual([53.5, 69.1])
  })
})

describe('calcBmr / calcTdee', () => {
  it('男女公式', () => {
    expect(calcBmr('male', 30, 175, 70)).toBe(1649)
    expect(calcBmr('female', 30, 165, 55)).toBe(1270)
  })
  it('TDEE', () => {
    expect(calcTdee(1649, 1.2)).toBe(1979)
  })
})
