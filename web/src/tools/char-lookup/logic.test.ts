import { beforeAll, describe, expect, it } from 'vitest'
import { infoToText, loadPinyin, lookupChar, MAX_CHARS, rangeOf, readingsOf, splitChars, unicodeOf, utf16Of, utf8Of, type PinyinLib } from './logic'

let lib: PinyinLib
beforeAll(async () => {
  lib = await loadPinyin()
})

describe('splitChars', () => {
  it('去空白、去重、保持顺序', () => {
    expect(splitChars('你 好\n你')).toEqual({ chars: ['你', '好'], truncated: false })
  })
  it('按码点拆，不劈开增补平面字符与 emoji', () => {
    expect(splitChars('𠮷😀').chars).toEqual(['𠮷', '😀'])
  })
  it('超过上限截断并标记', () => {
    const many = Array.from({ length: MAX_CHARS + 3 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('')
    const r = splitChars(many)
    expect(r.chars).toHaveLength(MAX_CHARS)
    expect(r.truncated).toBe(true)
    expect(splitChars('', 5)).toEqual({ chars: [], truncated: false })
  })
})

describe('Unicode 与字节', () => {
  it('基本区汉字', () => {
    expect(unicodeOf('一')).toBe('U+4E00')
    expect(utf8Of('一')).toBe('E4 B8 80')
    expect(utf16Of('一')).toBe('4E00')
  })
  it('增补平面汉字 𠮷', () => {
    expect(unicodeOf('𠮷')).toBe('U+20BB7')
    expect(utf8Of('𠮷')).toBe('F0 A0 AE B7')
    expect(utf16Of('𠮷')).toBe('D842 DFB7')
  })
  it('emoji', () => {
    expect(unicodeOf('😀')).toBe('U+1F600')
    expect(utf8Of('😀')).toBe('F0 9F 98 80')
    expect(utf16Of('😀')).toBe('D83D DE00')
  })
  it('ASCII 码点补到 4 位，字节单个', () => {
    expect(unicodeOf('A')).toBe('U+0041')
    expect(utf8Of('A')).toBe('41')
    expect(utf16Of('A')).toBe('0041')
  })
})

describe('rangeOf', () => {
  it('基本区、扩展区、兼容区', () => {
    expect(rangeOf('中')).toEqual({ han: true, basic: true, label: '基本区' })
    expect(rangeOf('㐀')).toMatchObject({ han: true, basic: false, label: '扩展 A 区' })
    expect(rangeOf('𠮷')).toMatchObject({ han: true, basic: false, label: '扩展 B 区' })
    expect(rangeOf('豈')).toMatchObject({ han: true, basic: false, label: '兼容汉字区' })
  })
  it('边界：U+4E00 与 U+9FFF 在基本区，U+A000 不是汉字', () => {
    expect(rangeOf('一').basic).toBe(true)
    expect(rangeOf('鿿').basic).toBe(true)
    expect(rangeOf('ꀀ').han).toBe(false)
  })
  it('非汉字', () => {
    expect(rangeOf('A')).toEqual({ han: false, basic: false, label: '非汉字' })
    expect(rangeOf('😀').han).toBe(false)
  })
})

describe('readingsOf / lookupChar', () => {
  it('多音字三种写法', () => {
    const r = readingsOf(lib, '长')
    expect(r.mark).toEqual(['cháng', 'zhǎng'])
    expect(r.num).toEqual(['chang2', 'zhang3'])
    expect(r.none).toEqual(['chang', 'zhang'])
  })
  it('无调写法会合并重复读音', () => {
    const r = readingsOf(lib, '行')
    expect(r.mark.length).toBeGreaterThan(r.none.length)
    expect(new Set(r.none).size).toBe(r.none.length)
  })
  it('非汉字、库认不出的字没有读音', () => {
    expect(readingsOf(lib, 'A')).toEqual({ mark: [], num: [], none: [] })
    expect(readingsOf(lib, '😀').mark).toEqual([])
    expect(readingsOf(lib, '𠮷').mark).toEqual([])
  })
  it('lookupChar 汇总各项', () => {
    const i = lookupChar(lib, '一')
    expect(i).toMatchObject({ char: '一', unicode: 'U+4E00', utf8: 'E4 B8 80', utf16: '4E00' })
    expect(i.readings.mark).toContain('yī')
  })
  it('infoToText：有读音与无读音', () => {
    const t = infoToText(lookupChar(lib, '长'))
    expect(t).toContain('读音：cháng、zhǎng（chang2、zhang3）')
    expect(t).toContain('Unicode：U+957F（基本区）')
    const e = infoToText(lookupChar(lib, '😀'))
    expect(e).not.toContain('读音')
    expect(e).toContain('UTF-16：D83D DE00')
  })
})
