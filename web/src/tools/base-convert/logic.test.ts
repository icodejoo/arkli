import { describe, expect, it } from 'vitest'
import { formatInBase, parseInBase, supportsBigInt, twosComplement } from './logic'

describe('parseInBase', () => {
  it('常用进制', () => {
    expect(parseInBase('ff', 16)).toEqual({ ok: true, value: 255n })
    expect(parseInBase('1010', 2)).toEqual({ ok: true, value: 10n })
    expect(parseInBase('777', 8)).toEqual({ ok: true, value: 511n })
    expect(parseInBase('z', 36)).toEqual({ ok: true, value: 35n })
  })
  it('负数、正号、分隔符', () => {
    expect(parseInBase('-10', 10)).toEqual({ ok: true, value: -10n })
    expect(parseInBase('+7', 10)).toEqual({ ok: true, value: 7n })
    expect(parseInBase('1111 0000_1111', 2)).toEqual({ ok: true, value: 0xf0fn })
  })
  it('超过 2^64 不丢精度', () => {
    const r = parseInBase('123456789012345678901234567890', 10)
    expect(r).toEqual({ ok: true, value: 123456789012345678901234567890n })
  })
  it('非法数字给提示', () => {
    expect(parseInBase('12', 2)).toMatchObject({ ok: false })
    expect(parseInBase('1.5', 10)).toMatchObject({ ok: false })
    expect(parseInBase('', 10)).toMatchObject({ ok: false })
    expect(parseInBase('-', 10)).toMatchObject({ ok: false })
    expect(parseInBase('中', 16)).toMatchObject({ ok: false })
  })
  it('进制越界', () => {
    expect(parseInBase('1', 1)).toMatchObject({ ok: false })
    expect(parseInBase('1', 37)).toMatchObject({ ok: false })
    expect(parseInBase('1', 2.5)).toMatchObject({ ok: false })
  })
})

describe('formatInBase', () => {
  it('大写输出、负数、零', () => {
    expect(formatInBase(255n, 16)).toBe('FF')
    expect(formatInBase(-255n, 2)).toBe('-11111111')
    expect(formatInBase(0n, 8)).toBe('0')
    expect(formatInBase(35n, 36)).toBe('Z')
  })
})

describe('twosComplement', () => {
  it('负数补码', () => {
    expect(twosComplement(-1n, 8)).toBe('11111111')
    expect(twosComplement(-128n, 8)).toBe('10000000')
    expect(twosComplement(-2n, 16)).toBe('1111111111111110')
  })
  it('正数补满位宽', () => {
    expect(twosComplement(5n, 8)).toBe('00000101')
    expect(twosComplement(255n, 8)).toBe('11111111')
  })
  it('超出范围为 null', () => {
    expect(twosComplement(-129n, 8)).toBeNull()
    expect(twosComplement(256n, 8)).toBeNull()
    expect(twosComplement(-(1n << 63n), 64)).toHaveLength(64)
  })
})

describe('supportsBigInt', () => {
  it('当前环境支持', () => {
    expect(supportsBigInt()).toBe(true)
  })
})
