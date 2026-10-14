import { describe, expect, it } from 'vitest'
import { generateNumbers, MAX_COUNT, type RandomOptions } from './logic'

/** 基础选项，测试里按需覆盖 */
const base: RandomOptions = { min: 1, max: 10, count: 5, allowDuplicates: true, sort: false, decimals: 0 }

describe('generateNumbers', () => {
  it('个数与范围正确', () => {
    const r = generateNumbers(base)
    expect(r).toHaveLength(5)
    expect(r.every((s) => Number(s) >= 1 && Number(s) <= 10)).toBe(true)
  })
  it('注入随机源可得到确定结果（含端点）', () => {
    expect(generateNumbers({ ...base, count: 2 }, () => 0)).toEqual(['1', '1'])
    expect(generateNumbers({ ...base, count: 1 }, () => 9)).toEqual(['10'])
  })
  it('不重复时无重复且取满范围', () => {
    const r = generateNumbers({ ...base, min: 1, max: 6, count: 6, allowDuplicates: false })
    expect(new Set(r).size).toBe(6)
  })
  it('不重复且个数超过可取值时抛错', () => {
    expect(() => generateNumbers({ ...base, min: 1, max: 3, count: 4, allowDuplicates: false })).toThrow(RangeError)
  })
  it('大范围不重复走集合分支', () => {
    const r = generateNumbers({ ...base, min: 1, max: 10000000, count: 50, allowDuplicates: false })
    expect(new Set(r).size).toBe(50)
  })
  it('排序', () => {
    const r = generateNumbers({ ...base, count: 50, sort: true }).map(Number)
    expect(r).toEqual(r.slice().sort((a, b) => a - b))
  })
  it('小数位数固定', () => {
    const r = generateNumbers({ ...base, min: 0, max: 1, decimals: 2, count: 20 })
    expect(r.every((s) => /^\d\.\d{2}$/.test(s))).toBe(true)
    expect(r.every((s) => Number(s) >= 0 && Number(s) <= 1)).toBe(true)
  })
  it('小数端点可取到', () => {
    expect(generateNumbers({ ...base, min: 0.5, max: 0.7, decimals: 1, count: 1 }, () => 0)).toEqual(['0.5'])
    expect(generateNumbers({ ...base, min: 0.5, max: 0.7, decimals: 1, count: 1 }, () => 2)).toEqual(['0.7'])
  })
  it('负数范围', () => {
    const r = generateNumbers({ ...base, min: -5, max: -1, count: 30 }).map(Number)
    expect(r.every((v) => v >= -5 && v <= -1)).toBe(true)
  })
  it('min 大于 max 时自动对调', () => {
    const r = generateNumbers({ ...base, min: 10, max: 1 }).map(Number)
    expect(r.every((v) => v >= 1 && v <= 10)).toBe(true)
  })
  it('min 等于 max', () => {
    expect(generateNumbers({ ...base, min: 7, max: 7, count: 2 })).toEqual(['7', '7'])
  })
  it('小数范围内没有可取值时抛错', () => {
    expect(() => generateNumbers({ ...base, min: 0.11, max: 0.19, decimals: 1 })).toThrow(RangeError)
  })
  it('非法个数、小数位数、非数字抛错', () => {
    expect(() => generateNumbers({ ...base, count: 0 })).toThrow(RangeError)
    expect(() => generateNumbers({ ...base, count: MAX_COUNT + 1 })).toThrow(RangeError)
    expect(() => generateNumbers({ ...base, count: 1.5 })).toThrow(RangeError)
    expect(() => generateNumbers({ ...base, decimals: 7 })).toThrow(RangeError)
    expect(() => generateNumbers({ ...base, min: NaN })).toThrow(RangeError)
  })
  it('范围过大抛错', () => {
    expect(() => generateNumbers({ ...base, min: 0, max: 1e12 })).toThrow(RangeError)
  })
  it('大样本大致均匀', () => {
    const c = [0, 0, 0]
    generateNumbers({ ...base, min: 0, max: 2, count: MAX_COUNT }).forEach((s) => c[Number(s)]++)
    for (const n of c) expect(Math.abs(n - MAX_COUNT / 3)).toBeLessThan(100)
  })
})
