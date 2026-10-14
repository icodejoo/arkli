import { describe, expect, it } from 'vitest'
import { normalizeItems, percentText, toRows } from './logic'

describe('normalizeItems', () => {
  it('降序、截取、丢弃非法项', () => {
    const items = [
      { label: '猫', score: 0.2 },
      { label: '狗', score: 0.7 },
      { label: '', score: 0.9 },
      { label: '鸟', score: NaN },
      { label: '鱼', score: 0.1 },
    ]
    expect(normalizeItems(items, 2)).toEqual([
      { label: '狗', score: 0.7 },
      { label: '猫', score: 0.2 },
    ])
  })
  it('不改动入参；topK 为 0 返回空', () => {
    const items = [
      { label: 'a', score: 0.1 },
      { label: 'b', score: 0.9 },
    ]
    normalizeItems(items, 5)
    expect(items[0].label).toBe('a')
    expect(normalizeItems(items, 0)).toEqual([])
  })
})

describe('percentText', () => {
  it('保留一位小数并夹紧', () => {
    expect(percentText(0.873)).toBe('87.3%')
    expect(percentText(1.5)).toBe('100.0%')
    expect(percentText(-1)).toBe('0.0%')
  })
})

describe('toRows', () => {
  it('条形相对第一名', () => {
    const rows = toRows([
      { label: 'a', score: 0.8 },
      { label: 'b', score: 0.4 },
      { label: 'c', score: 0.001 },
    ])
    expect(rows.map((r) => r.bar)).toEqual([100, 50, 2])
    expect(rows[0]).toEqual({ label: 'a', percent: '80.0%', bar: 100 })
  })
  it('空与全 0', () => {
    expect(toRows([])).toEqual([])
    expect(toRows([{ label: 'a', score: 0 }])[0].bar).toBe(2)
  })
})
