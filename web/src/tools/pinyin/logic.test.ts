import { beforeAll, describe, expect, it } from 'vitest'
import { convertPinyin, DEFAULT_OPTIONS, loadPinyin, MAX_INPUT_CHARS, type PinyinLib } from './logic'

let lib: PinyinLib
beforeAll(async () => {
  lib = await loadPinyin()
})

describe('convertPinyin', () => {
  it('带声调', () => {
    expect(convertPinyin(lib, '你好', DEFAULT_OPTIONS).text).toBe('nǐ hǎo')
  })

  it('数字声调与无声调', () => {
    expect(convertPinyin(lib, '你好', { ...DEFAULT_OPTIONS, tone: 'num' }).text).toBe('ni3 hao3')
    expect(convertPinyin(lib, '你好', { ...DEFAULT_OPTIONS, tone: 'none' }).text).toBe('ni hao')
  })

  it('首字母', () => {
    expect(convertPinyin(lib, '你好世界', { ...DEFAULT_OPTIONS, pattern: 'first', separator: '' }).text).toBe('nhsj')
  })

  it('自定义分隔符', () => {
    expect(convertPinyin(lib, '你好', { ...DEFAULT_OPTIONS, tone: 'none', separator: '-' }).text).toBe('ni-hao')
  })

  it('保留或丢弃非中文', () => {
    const keep = convertPinyin(lib, '你好,abc', { ...DEFAULT_OPTIONS, tone: 'none' }).text
    expect(keep).toContain('abc')
    const drop = convertPinyin(lib, '你好,abc', { ...DEFAULT_OPTIONS, tone: 'none', keepOther: false }).text
    expect(drop).toBe('ni hao')
  })

  it('词语级多音字：银行 / 长大', () => {
    expect(convertPinyin(lib, '银行', DEFAULT_OPTIONS).text).toBe('yín háng')
    expect(convertPinyin(lib, '长大', { ...DEFAULT_OPTIONS, tone: 'none' }).text).toBe('zhang da')
  })

  it('姓氏模式：单老师', () => {
    expect(convertPinyin(lib, '单老师', { ...DEFAULT_OPTIONS, surname: true }).text).toBe('shàn lǎo shī')
  })

  it('多音字提示列出全部读音且去重', () => {
    const r = convertPinyin(lib, '长长大', DEFAULT_OPTIONS)
    const chang = r.hints.filter((h) => h.char === '长')
    expect(chang).toHaveLength(1)
    expect(chang[0].all).toEqual(expect.arrayContaining(['zhǎng', 'cháng']))
  })

  it('空输入与超长输入', () => {
    expect(convertPinyin(lib, '', DEFAULT_OPTIONS)).toEqual({ text: '', hints: [] })
    expect(() => convertPinyin(lib, '长'.repeat(MAX_INPUT_CHARS + 1), DEFAULT_OPTIONS)).toThrow(RangeError)
  })
})
