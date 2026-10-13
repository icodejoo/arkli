import { describe, expect, it } from 'vitest'
import { decodeText, encodeText, MAX_INPUT_CHARS } from './logic'

/** 取成功结果的值，失败则让断言报错 */
function val(r: ReturnType<typeof encodeText>): string {
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('encodeText', () => {
  it('ASCII 与中文', () => {
    expect(val(encodeText('hello'))).toBe('aGVsbG8=')
    expect(val(encodeText('你好'))).toBe('5L2g5aW9')
  })
  it('空串得到空串', () => {
    expect(val(encodeText(''))).toBe('')
  })
  it('URL 安全与去填充', () => {
    // '>>>?' 编码含 + 和 /
    expect(val(encodeText('>>>?'))).toBe('Pj4+Pw==')
    expect(val(encodeText('>>>?', { urlSafe: true, padding: false }))).toBe('Pj4-Pw')
  })
  it('超大输入给提示而不抛错', () => {
    const r = encodeText('a'.repeat(MAX_INPUT_CHARS + 1))
    expect(r.ok).toBe(false)
  })
  it('较大输入分块也能正确往返', () => {
    const big = '汉a'.repeat(50000)
    expect(val(decodeText(val(encodeText(big))))).toBe(big)
  })
})

describe('decodeText', () => {
  it('往返：emoji、生僻字、混合文本', () => {
    for (const s of ['😀 emoji', '𠮷野家', 'line1\nline2\ttab', '']) {
      expect(val(decodeText(val(encodeText(s))))).toBe(s)
    }
  })
  it('缺填充、URL 安全、带空白换行都能解', () => {
    expect(val(decodeText('Pj4-Pw'))).toBe('>>>?')
    expect(val(decodeText('  5L2g\n5aW9  '))).toBe('你好')
  })
  it('剥掉 data URL 前缀', () => {
    expect(val(decodeText('data:text/plain;base64,aGVsbG8='))).toBe('hello')
  })
  it('非法字符、非法长度给提示', () => {
    expect(decodeText('abc$')).toEqual({ ok: false, error: '含有 Base64 不允许的字符' })
    expect(decodeText('abcde').ok).toBe(false)
    expect(decodeText('a=b=').ok).toBe(false)
  })
  it('二进制内容提示不是文本', () => {
    // 0xFF 0xFE 不是合法 UTF-8
    const r = decodeText('//4=')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('UTF-8')
  })
  it('超大输入给提示', () => {
    expect(decodeText('A'.repeat(MAX_INPUT_CHARS + 1)).ok).toBe(false)
  })
})
