import { describe, expect, it } from 'vitest'
import { getPixel, medianCut, PALETTE_MAX, PALETTE_MIN, pointToPixel, readableTextColor, toHex, toRgbText } from './logic'

/** 用若干 [r,g,b,a,重复次数] 生成 RGBA 数据 */
function build(parts: Array<[number, number, number, number, number]>): Uint8ClampedArray {
  const arr: number[] = []
  for (const [r, g, b, a, n] of parts) for (let i = 0; i < n; i++) arr.push(r, g, b, a)
  return new Uint8ClampedArray(arr)
}

describe('toHex / toRgbText', () => {
  it('格式化', () => {
    expect(toHex({ r: 255, g: 0, b: 128 })).toBe('#FF0080')
    expect(toHex({ r: 300, g: -5, b: 0.4 })).toBe('#FF0000')
    expect(toRgbText({ r: 1.2, g: 2, b: 3 })).toBe('rgb(1, 2, 3)')
  })
})

describe('readableTextColor', () => {
  it('亮底黑字，暗底白字', () => {
    expect(readableTextColor({ r: 255, g: 255, b: 255 })).toBe('#000000')
    expect(readableTextColor({ r: 0, g: 0, b: 0 })).toBe('#FFFFFF')
  })
})

describe('getPixel', () => {
  const data = new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0])
  it('取点与越界', () => {
    expect(getPixel(data, 2, 1, 0, 0)).toEqual({ r: 10, g: 20, b: 30 })
    expect(getPixel(data, 2, 1, 2, 0)).toBeNull()
    expect(getPixel(data, 2, 1, 0, -1)).toBeNull()
  })
  it('全透明点按白底', () => {
    expect(getPixel(data, 2, 1, 1, 0)).toEqual({ r: 255, g: 255, b: 255 })
  })
})

describe('pointToPixel', () => {
  it('按比例换算', () => {
    expect(pointToPixel(50, 25, 100, 50, 10, 5)).toEqual({ x: 5, y: 2 })
  })
  it('边界夹紧', () => {
    expect(pointToPixel(100, 50, 100, 50, 10, 5)).toEqual({ x: 9, y: 4 })
    expect(pointToPixel(-5, -5, 100, 50, 10, 5)).toEqual({ x: 0, y: 0 })
  })
  it('非法尺寸返回 null', () => {
    expect(pointToPixel(1, 1, 0, 50, 10, 5)).toBeNull()
  })
})

describe('medianCut', () => {
  it('两种纯色切出两色，占比正确', () => {
    const out = medianCut(build([[255, 0, 0, 255, 30], [0, 0, 255, 255, 10]]), 3)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ r: 255, g: 0, b: 0, count: 30 })
    expect(out[0].ratio).toBeCloseTo(0.75)
    expect(out[1]).toMatchObject({ r: 0, g: 0, b: 255 })
  })
  it('颜色数受目标限制', () => {
    const parts: Array<[number, number, number, number, number]> = []
    for (let i = 0; i < 20; i++) parts.push([i * 12, 255 - i * 12, (i * 37) % 256, 255, 5])
    expect(medianCut(build(parts), 5)).toHaveLength(5)
    expect(medianCut(build(parts), 100).length).toBeLessThanOrEqual(PALETTE_MAX)
    expect(medianCut(build(parts), 1).length).toBeGreaterThanOrEqual(PALETTE_MIN)
  })
  it('三色分明的图，主色接近原色', () => {
    const out = medianCut(build([[250, 10, 10, 255, 20], [10, 250, 10, 255, 20], [10, 10, 250, 255, 20]]), 3)
    expect(out.map(toHex).sort()).toEqual(['#0A0AFA', '#0AFA0A', '#FA0A0A'])
  })
  it('半透明像素被忽略，全透明返回空', () => {
    expect(medianCut(build([[1, 2, 3, 0, 10]]), 4)).toEqual([])
    const out = medianCut(build([[9, 9, 9, 255, 4], [200, 0, 0, 10, 100]]), 4)
    expect(out).toHaveLength(1)
    expect(out[0].r).toBe(9)
  })
  it('占比之和为 1，且按数量降序', () => {
    const out = medianCut(build([[0, 0, 0, 255, 5], [255, 255, 255, 255, 50], [128, 0, 0, 255, 20]]), 6)
    expect(out.reduce((s, c) => s + c.ratio, 0)).toBeCloseTo(1)
    for (let i = 1; i < out.length; i++) expect(out[i - 1].count).toBeGreaterThanOrEqual(out[i].count)
  })
})
