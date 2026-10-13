import { describe, expect, it } from 'vitest'
import { checkDraw, drawLots } from './logic'

describe('checkDraw', () => {
  it('选项不足、数量非法、数量过多都给提示', () => {
    expect(checkDraw(['a'], 1).error).toBe('至少需要 2 个选项')
    expect(checkDraw(['a', 'b'], 0).error).toBe('抽取数量至少为 1')
    expect(checkDraw(['a', 'b'], 1.5).error).toBe('抽取数量至少为 1')
    expect(checkDraw(['a', 'b'], 3).error).toBe('抽取数量不能超过选项数')
  })
  it('合法时无错误', () => {
    expect(checkDraw(['a', 'b'], 2).error).toBeNull()
  })
})

describe('drawLots', () => {
  it('抽出指定个数且不重复、都来自选项', () => {
    const items = ['a', 'b', 'c', 'd']
    const r = drawLots(items, 3)
    expect(new Set(r).size).toBe(3)
    expect(r.every((x) => items.includes(x))).toBe(true)
  })
  it('全抽等于洗牌后的全集', () => {
    expect(drawLots(['a', 'b', 'c'], 3).slice().sort()).toEqual(['a', 'b', 'c'])
  })
  it('非法输入抛错', () => {
    expect(() => drawLots(['a'], 1)).toThrow(RangeError)
  })
  it('每个选项被抽中的概率均等', () => {
    const c: Record<string, number> = { a: 0, b: 0, c: 0 }
    for (let i = 0; i < 9000; i++) c[drawLots(['a', 'b', 'c'], 1)[0]]++
    for (const k of Object.keys(c)) expect(Math.abs(c[k] - 3000)).toBeLessThan(300)
  })
})
