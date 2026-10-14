import { describe, expect, it } from 'vitest'
import { convertAll, convertFancy, FANCY_STYLES } from './logic'

describe('convertFancy', () => {
  it('上标：数字、符号与字母', () => {
    expect(convertFancy('x2+1', 'superscript')).toBe('ˣ²⁺¹')
    expect(convertFancy('abc', 'superscript')).toBe('ᵃᵇᶜ')
  })
  it('上标：映射表逐项对齐（数字全转、小写全转）', () => {
    expect(convertFancy('0123456789', 'superscript')).toBe('⁰¹²³⁴⁵⁶⁷⁸⁹')
    expect(convertFancy('hello', 'superscript')).toBe('ʰᵉˡˡᵒ')
    expect(convertFancy('N', 'superscript')).toBe('ᴺ')
  })
  it('下标', () => {
    expect(convertFancy('H2O', 'subscript')).toBe('H₂O')
    expect(convertFancy('x(1)', 'subscript')).toBe('ₓ₍₁₎')
  })
  it('小型大写', () => {
    expect(convertFancy('abc', 'smallcaps')).toBe('ᴀʙᴄ')
    expect(convertFancy('hi', 'smallcaps')).toBe('ʜɪ')
  })
  it('全角含空格', () => expect(convertFancy('Ab 1', 'fullwidth')).toBe('Ａｂ　１'))
  it('圈号', () => {
    expect(convertFancy('123', 'circled')).toBe('①②③')
    expect(convertFancy('Aa', 'circled')).toBe('Ⓐⓐ')
  })
  it('黑底圈号', () => {
    expect(convertFancy('1', 'circledBlack')).toBe('❶')
    expect(convertFancy('a', 'circledBlack')).toBe('🅐')
  })
  it('粗体与手写体', () => {
    expect(convertFancy('Ab1', 'bold')).toBe('𝐀𝐛𝟏')
    expect(convertFancy('ABe', 'mathScript')).toBe('𝒜ℬℯ')
  })
  it('没有映射的字符原样保留（中文、emoji）', () => {
    expect(convertFancy('你好😀', 'superscript')).toBe('你好😀')
  })
  it('空串返回空串', () => expect(convertFancy('', 'bold')).toBe(''))
  it('未知花样抛错', () => {
    expect(() => convertFancy('a', 'nope' as never)).toThrow(RangeError)
  })
  it('原型链上的键不会被误当成映射', () => {
    expect(convertFancy('constructor', 'bold')).not.toContain('function')
  })
})

describe('convertAll', () => {
  it('每种花样一条，顺序与 FANCY_STYLES 一致', () => {
    const r = convertAll('a1')
    expect(r.map((x) => x.id)).toEqual(FANCY_STYLES.map((s) => s.id))
    expect(r.find((x) => x.id === 'subscript')?.text).toBe('ₐ₁')
  })
  it('空串全是空串', () => expect(convertAll('').every((x) => x.text === '')).toBe(true))
})
