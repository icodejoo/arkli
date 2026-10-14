import { describe, expect, it } from 'vitest'
import { COLORFUL_THRESHOLD, isColorful, MAX_SIDE, validateColorize } from './logic'

describe('validateColorize', () => {
  it('未选图 / 尺寸过大 / 通过', () => {
    expect(validateColorize(null)).toBe('请先选择一张黑白照片')
    expect(validateColorize({ url: '', width: 1, height: 1 })).toBe('请先选择一张黑白照片')
    expect(validateColorize({ url: 'x', width: MAX_SIDE + 1, height: 10 })).toBe('图片尺寸过大，请先缩小')
    expect(validateColorize({ url: 'x', width: MAX_SIDE, height: MAX_SIDE })).toBeNull()
  })
})

describe('isColorful', () => {
  it('灰度图不是彩色', () => {
    expect(isColorful(new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255]))).toBe(false)
  })
  it('明显的颜色是彩色', () => {
    expect(isColorful(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]))).toBe(true)
  })
  it('轻微偏色（老照片泛黄）在阈值内仍算黑白', () => {
    expect(isColorful(new Uint8ClampedArray([120, 115, 110, 255]))).toBe(false)
    expect(COLORFUL_THRESHOLD).toBeGreaterThan(10)
  })
  it('空数据为 false；可自定义阈值', () => {
    expect(isColorful(new Uint8ClampedArray(0))).toBe(false)
    expect(isColorful(new Uint8ClampedArray([120, 115, 110, 255]), 5)).toBe(true)
  })
})
