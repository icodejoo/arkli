import { describe, expect, it } from 'vitest'
import { cellIndex, coverage, nextScreen, SCREENS } from './logic'

describe('nextScreen', () => {
  it('循环前进与后退', () => {
    expect(nextScreen(0)).toBe(1)
    expect(nextScreen(SCREENS.length - 1)).toBe(0)
    expect(nextScreen(0, -1)).toBe(SCREENS.length - 1)
  })
  it('顺序为红绿蓝白黑灰阶', () => {
    expect(SCREENS.map((s) => s.name)).toEqual(['纯红', '纯绿', '纯蓝', '纯白', '纯黑', '灰阶渐变'])
  })
})

describe('cellIndex', () => {
  it('左上、右下与中间', () => {
    expect(cellIndex(0, 0, 80, 140)).toBe(0)
    expect(cellIndex(79, 139, 80, 140)).toBe(8 * 14 - 1)
    expect(cellIndex(25, 15, 80, 140)).toBe(1 * 8 + 2)
  })
  it('区域外返回 -1', () => {
    expect(cellIndex(-1, 0, 80, 140)).toBe(-1)
    expect(cellIndex(80, 0, 80, 140)).toBe(-1)
    expect(cellIndex(0, 0, 0, 0)).toBe(-1)
  })
})

describe('coverage', () => {
  it('百分比取整并封顶', () => {
    expect(coverage(0)).toBe(0)
    expect(coverage(56)).toBe(50)
    expect(coverage(999)).toBe(100)
    expect(coverage(1, 0)).toBe(0)
  })
})
