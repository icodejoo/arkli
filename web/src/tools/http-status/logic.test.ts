import { describe, expect, it } from 'vitest'
import { CLASS_LABELS, STATUS_LIST } from './data'
import { classOf, findStatus, groupByClass, searchStatus } from './logic'

describe('STATUS_LIST 数据', () => {
  it('约 70 条，码值唯一且升序', () => {
    expect(STATUS_LIST.length).toBeGreaterThanOrEqual(65)
    const codes = STATUS_LIST.map((s) => s.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect([...codes].sort((a, b) => a - b)).toEqual(codes)
  })
  it('字段非空，且每个大类都有条目', () => {
    for (const s of STATUS_LIST) {
      expect(s.name && s.phrase && s.meaning && s.scene).toBeTruthy()
      expect(CLASS_LABELS[classOf(s.code)]).toBeTruthy()
    }
    for (const c of [1, 2, 3, 4, 5]) expect(STATUS_LIST.some((s) => classOf(s.code) === c)).toBe(true)
  })
  it('包含指定的常见码', () => {
    for (const c of [200, 301, 304, 401, 403, 404, 418, 429, 451, 500, 502, 503, 504]) expect(findStatus(c)).toBeTruthy()
  })
  it('非标准码有标注', () => {
    expect(findStatus(499)?.nonStandard).toBe(true)
    expect(findStatus(524)?.nonStandard).toBe(true)
    expect(findStatus(404)?.nonStandard).toBeUndefined()
  })
})

describe('classOf', () => {
  it('取百位', () => {
    expect(classOf(200)).toBe(2)
    expect(classOf(599)).toBe(5)
    expect(classOf(100)).toBe(1)
  })
  it('越界与非整数返回 0', () => {
    expect(classOf(99)).toBe(0)
    expect(classOf(600)).toBe(0)
    expect(classOf(404.5)).toBe(0)
    expect(classOf(NaN)).toBe(0)
  })
})

describe('findStatus', () => {
  it('精确查找', () => {
    expect(findStatus(404)?.name).toBe('未找到')
    expect(findStatus(418)?.phrase).toBe("I'm a teapot")
  })
  it('没有时返回 undefined', () => {
    expect(findStatus(299)).toBeUndefined()
  })
})

describe('searchStatus', () => {
  it('空串返回全部', () => {
    expect(searchStatus('  ')).toHaveLength(STATUS_LIST.length)
  })
  it('完整码精确命中，前缀命中一片', () => {
    expect(searchStatus('429').map((s) => s.code)).toEqual([429])
    const four = searchStatus('40')
    expect(four.length).toBeGreaterThan(5)
    expect(four.every((s) => String(s.code).startsWith('40'))).toBe(true)
    expect(searchStatus('5').every((s) => classOf(s.code) === 5)).toBe(true)
  })
  it('关键字搜中文、英文、场景', () => {
    expect(searchStatus('茶壶').map((s) => s.code)).toContain(418)
    expect(searchStatus('teapot').map((s) => s.code)).toContain(418)
    expect(searchStatus('cloudflare').length).toBeGreaterThan(3)
    expect(searchStatus('限流').map((s) => s.code)).toContain(429)
  })
  it('无结果返回空数组', () => {
    expect(searchStatus('不存在的词')).toEqual([])
    expect(searchStatus('999')).toEqual([])
  })
})

describe('groupByClass', () => {
  it('全部数据分成 5 组并保持顺序', () => {
    const g = groupByClass(STATUS_LIST)
    expect(g.map((x) => x.cls)).toEqual([1, 2, 3, 4, 5])
    expect(g.reduce((n, x) => n + x.items.length, 0)).toBe(STATUS_LIST.length)
  })
  it('空组不返回', () => {
    expect(groupByClass(searchStatus('40')).map((x) => x.cls)).toEqual([4])
    expect(groupByClass([])).toEqual([])
  })
})
