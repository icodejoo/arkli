import { describe, expect, it } from 'vitest'
import {
  changeCase,
  shareFileName,
  dedupeLines,
  findReplace,
  regexExtract,
  removeEmptyLines,
  sortLines,
  textStats,
  toFullWidth,
  toHalfWidth,
  trimLines,
  truncateText,
  utf8Length,
} from './logic'

describe('regexExtract', () => {
  it('提取数字', () => expect(regexExtract('a1b22c', '\\d+')).toEqual(['1', '22']))
  it('空表达式返回空', () => expect(regexExtract('abc', '')).toEqual([]))
  it('默认忽略大小写，可切换', () => {
    expect(regexExtract('aA', 'a')).toEqual(['a', 'A'])
    expect(regexExtract('aA', 'a', { caseSensitive: true })).toEqual(['a'])
  })
  it('去重', () => expect(regexExtract('a a b', '\\w', { unique: true })).toEqual(['a', 'b']))
  it('空匹配不死循环', () => expect(regexExtract('abc', 'x*')).toEqual([]))
  it('非法表达式抛错', () => expect(() => regexExtract('a', '(')).toThrow(SyntaxError))
})

describe('findReplace', () => {
  it('普通文本里特殊字符按字面处理', () => {
    expect(findReplace('a.b.c', '.', '-')).toEqual({ text: 'a-b-c', count: 2 })
  })
  it('正则支持捕获组与 $& $$', () => {
    expect(findReplace('ab', '(a)(b)', '$2$1', { regex: true }).text).toBe('ba')
    expect(findReplace('ab', 'a', '[$&]', { regex: true }).text).toBe('[a]b')
    expect(findReplace('ab', 'a', '$$', { regex: true }).text).toBe('$b')
  })
  it('空查找原样返回', () => expect(findReplace('abc', '', 'x')).toEqual({ text: 'abc', count: 0 }))
  it('区分大小写', () => {
    expect(findReplace('aA', 'a', 'x', { caseSensitive: true }).count).toBe(1)
  })
  it('非法正则抛错', () => expect(() => findReplace('a', '(', 'x', { regex: true })).toThrow(SyntaxError))
})

describe('行处理', () => {
  it('dedupeLines 保序', () => expect(dedupeLines('a\nb\na')).toBe('a\nb'))
  it('sortLines 升降序', () => {
    expect(sortLines('b\na\nc')).toBe('a\nb\nc')
    expect(sortLines('b\na\nc', true)).toBe('c\nb\na')
  })
  it('removeEmptyLines 含空白行', () => expect(removeEmptyLines('a\n\n 　\nb')).toBe('a\nb'))
  it('trimLines', () => expect(trimLines('  a \n　b　')).toBe('a\nb'))
})

describe('changeCase', () => {
  it('大小写与首字母', () => {
    expect(changeCase('Ab', 'upper')).toBe('AB')
    expect(changeCase('Ab', 'lower')).toBe('ab')
    expect(changeCase('hELLO wORLD 你好', 'title')).toBe('Hello World 你好')
  })
})

describe('全半角', () => {
  it('转半角', () => expect(toHalfWidth('ＡＢＣ１２３　！')).toBe('ABC123 !'))
  it('转全角', () => expect(toFullWidth('ABC 1!')).toBe('ＡＢＣ　１！'))
  it('中文不动', () => {
    expect(toHalfWidth('你好')).toBe('你好')
    expect(toFullWidth('你好')).toBe('你好')
  })
  it('往返一致', () => expect(toHalfWidth(toFullWidth('Hi, 1+2=3'))).toBe('Hi, 1+2=3'))
})

describe('textStats / utf8Length', () => {
  it('统计', () => expect(textStats('你好\nab')).toEqual({ chars: 5, charsNoSpace: 4, lines: 2, bytes: 9 }))
  it('空文本全零', () => expect(textStats('')).toEqual({ chars: 0, charsNoSpace: 0, lines: 0, bytes: 0 }))
  it('emoji 按一个字符、4 字节', () => {
    expect(textStats('😀').chars).toBe(1)
    expect(utf8Length('😀')).toBe(4)
  })
})

describe('truncateText', () => {
  it('不超长不截断', () => expect(truncateText('abc', 5)).toEqual({ text: 'abc', truncated: false }))
  it('超长截断', () => expect(truncateText('abcdef', 3)).toEqual({ text: 'abc', truncated: true }))
  it('不劈开代理对', () => expect(truncateText('a😀b', 2).text).toBe('a'))
})

describe('shareFileName', () => {
  it('空名用默认名，没扩展名补 .txt', () => {
    expect(shareFileName('')).toBe('text.txt')
    expect(shareFileName('  ')).toBe('text.txt')
    expect(shareFileName('..')).toBe('text.txt')
    expect(shareFileName('笔记')).toBe('笔记.txt')
  })
  it('保留已有扩展名，替换非法字符', () => {
    expect(shareFileName('a.md')).toBe('a.md')
    expect(shareFileName('a/b:c')).toBe('a_b_c.txt')
    expect(shareFileName('x?.csv')).toBe('x_.csv')
  })
})
