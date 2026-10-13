import { describe, expect, it } from 'vitest'
import {
  activeSets,
  AMBIGUOUS,
  CHARSETS,
  DEFAULT_OPTIONS,
  entropyBits,
  generateBatch,
  generatePassword,
  MAX_LENGTH,
  strengthOf,
  validateOptions,
  type PasswordOptions,
} from './logic'

/** 全选字符集的选项 */
const ALL: PasswordOptions = { ...DEFAULT_OPTIONS, sets: { upper: true, lower: true, digits: true, symbols: true } }

describe('validateOptions', () => {
  it('长度越界、无字符集、长度不够每类一个都报错', () => {
    expect(validateOptions({ ...ALL, length: 3 })).toContain('长度')
    expect(validateOptions({ ...ALL, length: MAX_LENGTH + 1 })).toContain('长度')
    expect(validateOptions({ ...ALL, sets: { upper: false, lower: false, digits: false, symbols: false } })).toBe('至少选择一种字符类型')
    expect(validateOptions({ ...ALL, length: 4 })).toBeNull()
  })
  it('默认选项合法', () => {
    expect(validateOptions(DEFAULT_OPTIONS)).toBeNull()
  })
})

describe('generatePassword', () => {
  it('长度正确，字符只来自所选字符集', () => {
    const pw = generatePassword({ ...DEFAULT_OPTIONS, length: 40 })
    expect(pw).toHaveLength(40)
    expect(/^[A-Za-z0-9]+$/.test(pw)).toBe(true)
  })
  it('每个选中字符集至少出现一次（长度恰好等于类数时也成立）', () => {
    for (let i = 0; i < 500; i++) {
      const pw = generatePassword({ ...ALL, length: 4 })
      for (const k of ['upper', 'lower', 'digits', 'symbols'] as const) {
        expect([...pw].some((c) => CHARSETS[k].includes(c))).toBe(true)
      }
    }
  })
  it('排除易混字符', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword({ ...ALL, length: 64, excludeAmbiguous: true })
      expect([...pw].some((c) => AMBIGUOUS.includes(c))).toBe(false)
    }
  })
  it('关闭每类至少一个后允许缺类', () => {
    // 随机源恒为 0：只会取到字符池第一个字符
    const pw = generatePassword({ ...DEFAULT_OPTIONS, length: 8, ensureEach: false }, () => 0)
    expect(pw).toBe('AAAAAAAA')
  })
  it('非法选项抛错', () => {
    expect(() => generatePassword({ ...ALL, length: 1 })).toThrow(RangeError)
  })
  it('字符分布大致均匀（数字集）', () => {
    const opts: PasswordOptions = { length: 128, sets: { upper: false, lower: false, digits: true, symbols: false }, excludeAmbiguous: false, ensureEach: true }
    const c: Record<string, number> = {}
    for (let i = 0; i < 400; i++) for (const ch of generatePassword(opts)) c[ch] = (c[ch] ?? 0) + 1
    const expected = (400 * 128) / 10
    for (const d of CHARSETS.digits) expect(Math.abs(c[d] - expected)).toBeLessThan(expected * 0.08)
  })
})

describe('generateBatch', () => {
  it('生成指定个数，越界抛错', () => {
    expect(generateBatch(DEFAULT_OPTIONS, 5)).toHaveLength(5)
    expect(() => generateBatch(DEFAULT_OPTIONS, 0)).toThrow(RangeError)
    expect(() => generateBatch(DEFAULT_OPTIONS, 21)).toThrow(RangeError)
  })
})

describe('activeSets / entropy / strength', () => {
  it('排除易混后字符集变小，不会出现空集', () => {
    const sets = activeSets({ ...ALL, excludeAmbiguous: true })
    expect(sets).toHaveLength(4)
    expect(sets[2]).toBe('23456789')
  })
  it('熵值 = 长度 × log2(池大小)', () => {
    const opts: PasswordOptions = { ...DEFAULT_OPTIONS, length: 10, sets: { upper: false, lower: false, digits: true, symbols: false } }
    expect(entropyBits(opts)).toBeCloseTo(10 * Math.log2(10), 6)
    expect(entropyBits({ ...opts, sets: { upper: false, lower: false, digits: false, symbols: false } })).toBe(0)
  })
  it('强度分级边界', () => {
    expect(strengthOf(39.9)).toBe('weak')
    expect(strengthOf(40)).toBe('fair')
    expect(strengthOf(60)).toBe('good')
    expect(strengthOf(80)).toBe('strong')
  })
})
