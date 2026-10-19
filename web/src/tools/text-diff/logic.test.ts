import { describe, expect, it } from 'vitest'
import { diffSeq, diffText, MAX_CELLS } from './logic'

/** 取成功结果 */
function ok(a: string, b: string, mode: 'line' | 'char'): { parts: { type: string; text: string }[]; stats: { del: number; add: number } } {
  const r = diffText(a, b, mode)
  if (!r.ok) throw new Error(r.error)
  return r
}

describe('diffSeq', () => {
  it('相同序列全是 eq', () => {
    expect(diffSeq(['a', 'b'], ['a', 'b'])?.every((o) => o.type === 'eq')).toBe(true)
  })
  it('中间替换', () => {
    expect(diffSeq(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { type: 'eq', item: 'a' },
      { type: 'del', item: 'b' },
      { type: 'add', item: 'x' },
      { type: 'eq', item: 'c' },
    ])
  })
  it('过大返回 null', () => {
    const n = Math.ceil(Math.sqrt(MAX_CELLS)) + 5
    expect(diffSeq(Array.from({ length: n }, (_, i) => 'a' + i), Array.from({ length: n }, (_, i) => 'b' + i))).toBeNull()
  })
})

describe('diffText 按行', () => {
  it('统计增删行', () => {
    const r = ok('a\nb\nc', 'a\nc\nd', 'line')
    expect(r.stats).toEqual({ del: 1, add: 1 })
    expect(r.parts.map((p) => p.type + ':' + p.text)).toEqual(['eq:a', 'del:b', 'eq:c', 'add:d'])
  })
  it('两边都空', () => {
    expect(ok('', '', 'line').parts).toEqual([])
  })
  it('旧文本空则全部新增', () => {
    expect(ok('', 'x\ny', 'line').stats).toEqual({ del: 0, add: 2 })
  })
  it('CRLF 与 LF 视为相同', () => {
    expect(ok('a\r\nb', 'a\nb', 'line').stats).toEqual({ del: 0, add: 0 })
  })
})

describe('diffText 按字符', () => {
  it('连续字符合并成片段', () => {
    const r = ok('hello world', 'hello there', 'char')
    expect(r.parts.map((p) => p.text).join('')).toContain('hello ')
    expect(r.stats.del).toBeGreaterThan(0)
    expect(r.stats.add).toBeGreaterThan(0)
  })
  it('还原：eq+del 拼回旧文本，eq+add 拼回新文本', () => {
    const a = 'kitten sitting'
    const b = 'sitting kitten!'
    const r = ok(a, b, 'char')
    expect(r.parts.filter((p) => p.type !== 'add').map((p) => p.text).join('')).toBe(a)
    expect(r.parts.filter((p) => p.type !== 'del').map((p) => p.text).join('')).toBe(b)
  })
  it('超长文本给错误提示', () => {
    const r = diffText('a'.repeat(3000) + 'x', 'b'.repeat(3000) + 'y', 'char')
    expect(r.ok).toBe(false)
  })
})
