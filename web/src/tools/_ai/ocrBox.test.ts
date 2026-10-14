import { describe, expect, it } from 'vitest'
import { boxPoints, boxRect, pointInBox, scaleBox } from './ocrBox'

/** 10x4 的矩形框 */
const RECT = [0, 0, 10, 0, 10, 4, 0, 4]
/** 菱形（倾斜）框 */
const DIAMOND = [5, 0, 10, 5, 5, 10, 0, 5]

describe('boxRect', () => {
  it('矩形框', () => {
    expect(boxRect(RECT)).toEqual({ x1: 0, y1: 0, x2: 10, y2: 4, cx: 5, cy: 2, w: 10, h: 4 })
  })
  it('倾斜框取外接矩形', () => {
    const r = boxRect([1, 2, 11, 0, 12, 4, 2, 6])
    expect([r.x1, r.y1, r.x2, r.y2]).toEqual([1, 0, 12, 6])
  })
  it('点数不足返回全 0', () => {
    expect(boxRect([]).w).toBe(0)
  })
})

describe('pointInBox', () => {
  it('框内、框外', () => {
    expect(pointInBox(RECT, 5, 2)).toBe(true)
    expect(pointInBox(RECT, 11, 2)).toBe(false)
    expect(pointInBox(RECT, 5, -1)).toBe(false)
  })
  it('菱形：外接矩形角上的点不算命中', () => {
    expect(pointInBox(DIAMOND, 5, 5)).toBe(true)
    expect(pointInBox(DIAMOND, 0.5, 0.5)).toBe(false)
  })
})

describe('scaleBox / boxPoints', () => {
  it('缩放', () => {
    expect(scaleBox(RECT, 0.5)).toEqual([0, 0, 5, 0, 5, 2, 0, 2])
  })
  it('转 points', () => {
    expect(boxPoints(RECT)).toBe('0,0 10,0 10,4 0,4')
  })
})
