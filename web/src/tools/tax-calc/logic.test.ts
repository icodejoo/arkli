import { describe, expect, it } from 'vitest'
import { ANNUAL_BRACKETS, MONTHLY_BRACKETS, calcBonusCombined, calcBonusSeparate, calcByBrackets, calcSalaryTax, compareBonus } from './logic'

const Y = 100
const salary = calcSalaryTax({ monthlyCents: 20000 * Y, insuranceCents: 3000 * Y, specialCents: 2000 * Y })

describe('税率表', () => {
  it('各档递增且末档无上限', () => {
    expect(ANNUAL_BRACKETS).toHaveLength(7)
    expect(MONTHLY_BRACKETS).toHaveLength(7)
    expect(ANNUAL_BRACKETS[6].upTo).toBe(Infinity)
  })
})

describe('calcByBrackets', () => {
  it('档位边界与速算扣除数', () => {
    expect(calcByBrackets(36000 * Y, ANNUAL_BRACKETS)).toBe(1080 * Y)
    expect(calcByBrackets(36001 * Y, ANNUAL_BRACKETS)).toBe(Math.round(36001 * Y * 0.1) - 2520 * Y)
    expect(calcByBrackets(120000 * Y, ANNUAL_BRACKETS)).toBe(9480 * Y)
    expect(calcByBrackets(1000000 * Y, ANNUAL_BRACKETS)).toBe(268080 * Y)
  })
  it('非正数为 0', () => {
    expect(calcByBrackets(0, ANNUAL_BRACKETS)).toBe(0)
    expect(calcByBrackets(-5, ANNUAL_BRACKETS)).toBe(0)
  })
})

describe('calcSalaryTax', () => {
  it('月薪 2 万，五险一金 3 千，专项 2 千', () => {
    expect(salary.taxableCents).toBe(120000 * Y)
    expect(salary.taxCents).toBe(9480 * Y)
    expect(salary.afterTaxCents).toBe((240000 - 36000 - 9480) * Y)
  })
  it('低于起征点不缴税', () => {
    const r = calcSalaryTax({ monthlyCents: 4000 * Y, insuranceCents: 0, specialCents: 0 })
    expect(r.taxCents).toBe(0)
    expect(r.taxableCents).toBe(0)
  })
})

describe('年终奖', () => {
  it('单独计税：3.6 万按 3%', () => {
    expect(calcBonusSeparate(36000 * Y)).toBe(1080 * Y)
  })
  it('单独计税：跨档（36001 元月均 3000.08，10%）', () => {
    expect(calcBonusSeparate(36001 * Y)).toBe(Math.round(36001 * Y * 0.1) - 210 * Y)
  })
  it('并入综合所得：增量税额', () => {
    expect(calcBonusCombined(salary, 36000 * Y)).toBe(4800 * Y)
  })
  it('对比取更省的方式', () => {
    const c = compareBonus(salary, 36000 * Y)
    expect(c.better).toBe('separate')
    expect(compareBonus(salary, 0).better).toBe('same')
  })
})
