import { describe, expect, it } from 'vitest'
import { calcOutHeight, OUT_MIN_HEIGHT } from './outHeight'

describe('calcOutHeight', () => {
  it('页面高度 - pageY - 下方占用', () => {
    expect(calcOutHeight(800, 300, 74)).toBe(426)
  })
  it('空间不够时取最小高度', () => {
    expect(calcOutHeight(400, 380, 74)).toBe(OUT_MIN_HEIGHT)
  })
  it('小数向下取整', () => {
    expect(calcOutHeight(800.7, 300.2, 74)).toBe(426)
  })
})
