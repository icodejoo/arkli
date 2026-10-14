import { describe, expect, it } from 'vitest'
import { calcCombined, calcLoan, formatCents, yuanToCents } from './logic'

const MILLION = 100000000

describe('yuanToCents / formatCents', () => {
  it('元转分四舍五入', () => {
    expect(yuanToCents(12.345)).toBe(1235)
    expect(yuanToCents(0)).toBe(0)
    expect(yuanToCents(1000000)).toBe(MILLION)
  })
  it('分格式化带千分位和两位小数', () => {
    expect(formatCents(123450)).toBe('1,234.50')
    expect(formatCents(5)).toBe('0.05')
    expect(formatCents(-100)).toBe('-1.00')
    expect(formatCents(MILLION)).toBe('1,000,000.00')
  })
})

describe('calcLoan 等额本息', () => {
  it('100 万 3.5% 30 年月供约 4490.45', () => {
    const r = calcLoan({ principalCents: MILLION, annualRatePct: 3.5, months: 360 }, 'equal-payment')
    expect(formatCents(r.firstPayment)).toBe('4,490.45')
    expect(r.rows).toHaveLength(360)
  })
  it('本金合计精确等于贷款额，余额归零', () => {
    const r = calcLoan({ principalCents: 98765432, annualRatePct: 4.1, months: 247 }, 'equal-payment')
    expect(r.rows.reduce((s, x) => s + x.principal, 0)).toBe(98765432)
    expect(r.rows[r.rows.length - 1].balance).toBe(0)
    expect(r.totalPayment).toBe(98765432 + r.totalInterest)
  })
  it('尾差不超过几元', () => {
    const r = calcLoan({ principalCents: MILLION, annualRatePct: 3.5, months: 360 }, 'equal-payment')
    expect(Math.abs(r.lastPayment - r.firstPayment)).toBeLessThan(500)
  })
  it('利率为 0 时无利息', () => {
    const r = calcLoan({ principalCents: 120000, annualRatePct: 0, months: 12 }, 'equal-payment')
    expect(r.totalInterest).toBe(0)
    expect(r.firstPayment).toBe(10000)
  })
  it('一期还清', () => {
    const r = calcLoan({ principalCents: 10000, annualRatePct: 12, months: 1 }, 'equal-payment')
    expect(r.rows).toEqual([{ period: 1, payment: 10100, principal: 10000, interest: 100, balance: 0 }])
  })
})

describe('calcLoan 等额本金', () => {
  it('月供逐月递减，首月 = 本金/期数 + 首月利息', () => {
    const r = calcLoan({ principalCents: MILLION, annualRatePct: 3.5, months: 360 }, 'equal-principal')
    expect(r.rows[0].principal).toBe(Math.floor(MILLION / 360))
    expect(r.rows[0].interest).toBe(Math.round((MILLION * 0.035) / 12))
    expect(r.firstPayment).toBeGreaterThan(r.lastPayment)
    expect(r.rows[359].balance).toBe(0)
  })
  it('除不尽时余数并入最后一期', () => {
    const r = calcLoan({ principalCents: 1000, annualRatePct: 0, months: 3 }, 'equal-principal')
    expect(r.rows.map((x) => x.principal)).toEqual([333, 333, 334])
  })
  it('总利息低于同条件等额本息', () => {
    const a = calcLoan({ principalCents: MILLION, annualRatePct: 3.5, months: 240 }, 'equal-payment')
    const b = calcLoan({ principalCents: MILLION, annualRatePct: 3.5, months: 240 }, 'equal-principal')
    expect(b.totalInterest).toBeLessThan(a.totalInterest)
  })
})

describe('calcLoan 输入校验', () => {
  it('非法输入抛 RangeError', () => {
    const ok = { principalCents: 100, annualRatePct: 3, months: 12 }
    expect(() => calcLoan({ ...ok, principalCents: 0 }, 'equal-payment')).toThrow(RangeError)
    expect(() => calcLoan({ ...ok, principalCents: 1.5 }, 'equal-payment')).toThrow(RangeError)
    expect(() => calcLoan({ ...ok, months: 0 }, 'equal-payment')).toThrow(RangeError)
    expect(() => calcLoan({ ...ok, months: 361 }, 'equal-payment')).toThrow(RangeError)
    expect(() => calcLoan({ ...ok, annualRatePct: -1 }, 'equal-payment')).toThrow(RangeError)
    expect(() => calcLoan({ ...ok, annualRatePct: NaN }, 'equal-payment')).toThrow(RangeError)
  })
})

describe('calcCombined', () => {
  const a = { principalCents: 50000000, annualRatePct: 3.5, months: 360 }
  const b = { principalCents: 30000000, annualRatePct: 2.85, months: 300 }
  it('逐月相加，期数取最长，汇总等于两笔之和', () => {
    const c = calcCombined([a, b], 'equal-payment')
    const ra = calcLoan(a, 'equal-payment')
    const rb = calcLoan(b, 'equal-payment')
    expect(c.rows).toHaveLength(360)
    expect(c.firstPayment).toBe(ra.firstPayment + rb.firstPayment)
    expect(c.totalInterest).toBe(ra.totalInterest + rb.totalInterest)
    expect(c.totalPayment).toBe(ra.totalPayment + rb.totalPayment)
    expect(c.rows[359].payment).toBe(ra.rows[359].payment)
    expect(c.rows[359].balance).toBe(0)
  })
  it('单笔等价于 calcLoan', () => {
    expect(calcCombined([a], 'equal-principal')).toEqual(calcLoan(a, 'equal-principal'))
  })
  it('空列表抛错', () => {
    expect(() => calcCombined([], 'equal-payment')).toThrow(RangeError)
  })
})
