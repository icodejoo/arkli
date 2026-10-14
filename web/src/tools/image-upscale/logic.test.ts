import { describe, expect, it } from 'vitest'
import { DEFAULT_SPLIT, estimateText, estimateUpscale, maxAllowedScale, scaleSuffix, splitClip, splitFromPointer } from './logic'

describe('estimateUpscale', () => {
  it('算输出尺寸与内存', () => {
    expect(estimateUpscale(1000, 800, 4)).toEqual({ width: 4000, height: 3200, pixels: 12_800_000, memoryBytes: 51_200_000, tooBig: false })
  })
  it('超像素上限、超边长上限', () => {
    expect(estimateUpscale(5000, 4000, 4).tooBig).toBe(true)
    expect(estimateUpscale(5000, 10, 4).tooBig).toBe(true)
    expect(estimateUpscale(4000, 4000, 2).tooBig).toBe(false)
  })
})

describe('maxAllowedScale', () => {
  it('按上限给出最大倍数', () => {
    expect(maxAllowedScale(1000, 1000)).toBe(4)
    expect(maxAllowedScale(3000, 3000)).toBe(2)
    expect(maxAllowedScale(6000, 6000)).toBe(0)
  })
})

describe('estimateText', () => {
  it('正常与超限', () => {
    expect(estimateText(estimateUpscale(1000, 800, 2))).toBe('输出 2000×1600，解码约占 12.2 MB 内存')
    expect(estimateText(estimateUpscale(6000, 6000, 4))).toContain('超出上限')
  })
})

describe('splitFromPointer', () => {
  it('换算并夹紧', () => {
    expect(splitFromPointer(150, 100, 200)).toBe(0.25)
    expect(splitFromPointer(50, 100, 200)).toBe(0)
    expect(splitFromPointer(999, 100, 200)).toBe(1)
    expect(splitFromPointer(5, 0, 0)).toBe(DEFAULT_SPLIT)
  })
})

describe('splitClip', () => {
  it('生成 clip-path 并夹紧', () => {
    expect(splitClip(0.25)).toBe('inset(0 75% 0 0)')
    expect(splitClip(1)).toBe('inset(0 0% 0 0)')
    expect(splitClip(-3)).toBe('inset(0 100% 0 0)')
  })
})

describe('scaleSuffix', () => {
  it('后缀', () => {
    expect(scaleSuffix(2)).toBe('_x2')
    expect(scaleSuffix(4)).toBe('_x4')
  })
})
