import { describe, expect, it } from 'vitest'
import { calcAa, calcDiscount, calcTip, isBillTab, isDiscountOrder, splitCents } from './logic'

describe('splitCents', () => {
  it('余数分给靠前的人且合计不变', () => {
    expect(splitCents(100, 3)).toEqual([34, 33, 33])
    expect(splitCents(9000, 3)).toEqual([3000, 3000, 3000])
    expect(splitCents(2, 5)).toEqual([1, 1, 0, 0, 0])
  })
})

describe('calcTip', () => {
  it('15% 小费两人分', () => {
    const r = calcTip(10000, 15, 2)
    expect(r.tipCents).toBe(1500)
    expect(r.totalCents).toBe(11500)
    expect(r.perPerson).toEqual([5750, 5750])
  })
  it('四舍五入到分且人均合计精确', () => {
    const r = calcTip(3333, 12.5, 3)
    expect(r.perPerson.reduce((a, b) => a + b, 0)).toBe(r.totalCents)
  })
  it('零小费', () => {
    expect(calcTip(5000, 0, 1).totalCents).toBe(5000)
  })
})

describe('calcAa', () => {
  it('全员均摊', () => {
    expect(calcAa(3, [{ name: '饭', cents: 9000, members: [0, 1, 2] }])).toEqual([3000, 3000, 3000])
  })
  it('部分人参与', () => {
    const r = calcAa(3, [
      { name: '饭', cents: 9000, members: [0, 1, 2] },
      { name: '酒', cents: 3000, members: [0, 2] },
    ])
    expect(r).toEqual([4500, 3000, 4500])
  })
  it('不能整除时合计精确，无参与者的项目被忽略', () => {
    const r = calcAa(3, [
      { name: 'a', cents: 100, members: [0, 1, 2] },
      { name: 'b', cents: 500, members: [] },
    ])
    expect(r).toEqual([34, 33, 33])
  })
})

describe('calcDiscount', () => {
  it('先折后减 / 先减后折', () => {
    const base = { originalCents: 10000, zhe: 8, reduceCents: 1000 }
    expect(calcDiscount({ ...base, order: 'rate-first' }).finalCents).toBe(7000)
    expect(calcDiscount({ ...base, order: 'reduce-first' }).finalCents).toBe(7200)
  })
  it('综合折扣与节省', () => {
    const r = calcDiscount({ originalCents: 10000, zhe: 8.5, reduceCents: 0, order: 'rate-first' })
    expect(r.finalCents).toBe(8500)
    expect(r.savedCents).toBe(1500)
    expect(r.effectiveZhe).toBe(8.5)
  })
  it('立减超过价格时不为负，折扣为 0 视为不打折', () => {
    expect(calcDiscount({ originalCents: 500, zhe: 0, reduceCents: 900, order: 'rate-first' }).finalCents).toBe(0)
    expect(calcDiscount({ originalCents: 500, zhe: 0, reduceCents: 0, order: 'rate-first' }).finalCents).toBe(500)
  })
})

describe('缓存校验', () => {
  it('标签页与叠加顺序：非法值被拒', () => {
    expect(isBillTab('aa')).toBe(true)
    expect(isBillTab('x')).toBe(false)
    expect(isDiscountOrder('reduce-first')).toBe(true)
    expect(isDiscountOrder(1)).toBe(false)
  })
})
