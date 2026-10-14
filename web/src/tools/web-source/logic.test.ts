import { describe, expect, it } from 'vitest'
import { clipBody, MAX_SHOW_CHARS, normalizeUrl, sortHeaders, sourceFileName } from './logic'

describe('normalizeUrl', () => {
  it('缺协议补 https', () => {
    expect(normalizeUrl(' example.com/a?b=1 ')).toEqual({ ok: true, url: 'https://example.com/a?b=1' })
    expect(normalizeUrl('localhost:8080')).toEqual({ ok: true, url: 'https://localhost:8080/' })
  })
  it('保留 http', () => {
    expect(normalizeUrl('http://a.com')).toEqual({ ok: true, url: 'http://a.com/' })
  })
  it('空串、空格、非 http 协议、坏格式都拒绝', () => {
    expect(normalizeUrl('  ').ok).toBe(false)
    expect(normalizeUrl('a b.com').ok).toBe(false)
    expect(normalizeUrl('ftp://a.com')).toEqual({ ok: false, error: '只支持 http 和 https' })
    expect(normalizeUrl('file:///etc/passwd').ok).toBe(false)
    expect(normalizeUrl('javascript:alert(1)').ok).toBe(false)
    expect(normalizeUrl('https://').ok).toBe(false)
  })
})

describe('clipBody', () => {
  it('不超长原样返回', () => {
    expect(clipBody('abc')).toEqual({ text: 'abc', truncated: false, total: 3 })
  })
  it('超长截断并给出总数', () => {
    expect(clipBody('abcdef', 3)).toEqual({ text: 'abc', truncated: true, total: 6 })
    expect(clipBody('x'.repeat(MAX_SHOW_CHARS + 1)).text.length).toBe(MAX_SHOW_CHARS)
  })
})

describe('sortHeaders', () => {
  it('按键名排序', () => {
    expect(sortHeaders({ b: '2', a: '1' })).toEqual([['a', '1'], ['b', '2']])
    expect(sortHeaders({})).toEqual([])
  })
})

describe('sourceFileName', () => {
  it('主机名加扩展名', () => {
    expect(sourceFileName('https://a.com/x', 'text/html; charset=utf-8')).toBe('a.com.html')
    expect(sourceFileName('https://a.com/x', 'application/json')).toBe('a.com.json')
    expect(sourceFileName('https://a.com/x')).toBe('a.com.txt')
  })
  it('地址坏了用默认名', () => {
    expect(sourceFileName('???')).toBe('source.txt')
  })
})
