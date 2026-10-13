import { describe, expect, it } from 'vitest'
import { cleanText, clampNum, DEFAULT_TEXT, loadRecent, pushRecent, RECENT_MAX, saveRecent, scrollDuration, TEXT_MAX, type KvStorage } from './logic'

/** 内存存储 */
function mem(init: Record<string, string> = {}): KvStorage {
  const m = { ...init }
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => void (m[k] = v) }
}

describe('clampNum', () => {
  it('范围内原样，越界钳制，非法用兜底', () => {
    expect(clampNum(100, 40, 320, 160)).toBe(100)
    expect(clampNum(999, 40, 320, 160)).toBe(320)
    expect(clampNum(1, 40, 320, 160)).toBe(40)
    expect(clampNum('abc', 40, 320, 160)).toBe(160)
    expect(clampNum('200', 40, 320, 160)).toBe(200)
    expect(clampNum(NaN, 40, 320, 160)).toBe(160)
  })
})

describe('cleanText', () => {
  it('去空白、换行变空格', () => {
    expect(cleanText('  hi\n\nthere ')).toBe('hi there')
  })
  it('空文案用默认', () => {
    expect(cleanText('   \n ')).toBe(DEFAULT_TEXT)
  })
  it('超长按字符截断且不拆 emoji', () => {
    const t = cleanText('😀'.repeat(TEXT_MAX + 20))
    expect(Array.from(t)).toHaveLength(TEXT_MAX)
    expect(t.endsWith('😀')).toBe(true)
  })
})

describe('scrollDuration', () => {
  it('(文字宽+屏宽)/速度', () => {
    expect(scrollDuration(400, 600, 200)).toBe(5)
    expect(scrollDuration(0, 600, 300)).toBe(2)
  })
  it('非法入参为 0', () => {
    expect(scrollDuration(100, 0, 100)).toBe(0)
    expect(scrollDuration(100, 100, 0)).toBe(0)
    expect(scrollDuration(-1, 100, 100)).toBe(0)
    expect(scrollDuration(NaN, 100, 100)).toBe(0)
  })
})

describe('最近文案', () => {
  it('新的在最前、去重、限条数', () => {
    expect(pushRecent(['a', 'b'], 'b')).toEqual(['b', 'a'])
    const many = Array.from({ length: RECENT_MAX }, (_, i) => String(i))
    expect(pushRecent(many, 'new')).toHaveLength(RECENT_MAX)
    expect(pushRecent(many, 'new')[0]).toBe('new')
  })
  it('空文案不入列', () => {
    expect(pushRecent(['a'], '  ')).toEqual(['a'])
  })
  it('存取往返；损坏数据与异常存储不崩', () => {
    const s = mem()
    saveRecent(s, ['x', 'y'])
    expect(loadRecent(s)).toEqual(['x', 'y'])
    expect(loadRecent(mem({ 'arkli:danmaku:recent': '{bad' }))).toEqual([])
    expect(loadRecent(mem({ 'arkli:danmaku:recent': '[1,"a"]' }))).toEqual(['a'])
    const bad: KvStorage = {
      getItem: () => {
        throw new Error('x')
      },
      setItem: () => {
        throw new Error('x')
      },
    }
    expect(loadRecent(bad)).toEqual([])
    expect(() => saveRecent(bad, ['a'])).not.toThrow()
    expect(loadRecent(undefined)).toEqual([])
  })
})
