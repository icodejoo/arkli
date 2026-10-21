import { describe, expect, it } from 'vitest'
import { inRange, isBool, isHexColor, oneOf } from './persistValidators'

describe('persistValidators', () => {
  it('inRange 只认范围内的有限数字', () => {
    expect(inRange(5, { min: 0, max: 10 })).toBe(true)
    expect(inRange(11, { min: 0, max: 10 })).toBe(false)
    expect(inRange('5', { min: 0, max: 10 })).toBe(false)
    expect(inRange(NaN, { min: 0, max: 10 })).toBe(false)
  })
  it('isHexColor 只认 #rrggbb', () => {
    expect(isHexColor('#FfAa00')).toBe(true)
    expect(isHexColor('red')).toBe(false)
    expect(isHexColor(null)).toBe(false)
  })
  it('oneOf 支持选项对象与普通值', () => {
    expect(oneOf([{ value: 'a', label: 'A' }])('a')).toBe(true)
    expect(oneOf([{ value: 'a', label: 'A' }])('b')).toBe(false)
    expect(oneOf([1, 2])(2)).toBe(true)
  })
  it('isBool 只认布尔', () => {
    expect(isBool(false)).toBe(true)
    expect(isBool(0)).toBe(false)
  })
})
