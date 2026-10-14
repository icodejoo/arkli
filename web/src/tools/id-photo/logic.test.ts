import { describe, expect, it } from 'vitest'
import {
  backgroundMask,
  clamp,
  clampCrop,
  colorDistance,
  CUSTOM_MAX,
  CUSTOM_MIN,
  cropRect,
  customSpec,
  featherAlpha,
  hexToRgb,
  ID_SPECS,
  initialCrop,
  maxCropWidth,
  moveCrop,
  pinchFrac,
  rectToPercent,
  replaceBackground,
  rgbToHex,
  sampleColor,
  specAspect,
  type Rgb,
} from './logic'

/** 造 RGBA：rows 每个字符是调色板 key */
function rgba(rows: string[], pal: Record<string, Rgb>): { data: Uint8ClampedArray; w: number; h: number } {
  const h = rows.length
  const w = rows[0].length
  const data = new Uint8ClampedArray(w * h * 4)
  rows.forEach((r, y) =>
    r.split('').forEach((ch, x) => {
      const p = (y * w + x) * 4
      data[p] = pal[ch][0]
      data[p + 1] = pal[ch][1]
      data[p + 2] = pal[ch][2]
      data[p + 3] = 255
    }),
  )
  return { data, w, h }
}

const WHITE: Rgb = [255, 255, 255]
const BLUE: Rgb = [0, 0, 255]
const BLACK: Rgb = [0, 0, 0]

describe('规格', () => {
  it('内置规格尺寸正确', () => {
    expect(ID_SPECS.map((s) => [s.width, s.height])).toEqual([
      [295, 413],
      [413, 579],
      [390, 567],
      [600, 600],
    ])
    expect(specAspect(ID_SPECS[3])).toBe(1)
  })
  it('customSpec 夹紧并取整，非数字退到下限', () => {
    expect(customSpec(10, 99999)).toMatchObject({ width: CUSTOM_MIN, height: CUSTOM_MAX, id: 'custom' })
    expect(customSpec(300.4, 400.6)).toMatchObject({ width: 300, height: 401 })
    expect(customSpec(NaN, NaN)).toMatchObject({ width: CUSTOM_MIN, height: CUSTOM_MIN })
  })
  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
  })
})

describe('裁剪框坐标', () => {
  it('maxCropWidth：竖框受高限制或受宽限制', () => {
    expect(maxCropWidth(1000, 1000, 0.5)).toBe(500)
    expect(maxCropWidth(300, 1000, 0.5)).toBe(300)
  })
  it('initialCrop 居中最大框', () => {
    expect(initialCrop(1000, 1000, 0.5)).toEqual({ frac: 1, cx: 500, cy: 500 })
    expect(cropRect(1000, 1000, 0.5, initialCrop(1000, 1000, 0.5))).toEqual({ x: 250, y: 0, w: 500, h: 1000 })
  })
  it('clampCrop：框不出图，比例夹紧', () => {
    expect(clampCrop(100, 100, 1, { frac: 1, cx: -50, cy: 500 })).toEqual({ frac: 1, cx: 50, cy: 50 })
    expect(clampCrop(100, 100, 1, { frac: 0.5, cx: 0, cy: 0 })).toEqual({ frac: 0.5, cx: 25, cy: 25 })
    expect(clampCrop(100, 100, 1, { frac: 9, cx: 50, cy: 50 }).frac).toBe(1)
    expect(clampCrop(100, 100, 1, { frac: 0, cx: 50, cy: 50 }).frac).toBe(0.2)
  })
  it('cropRect 保持宽高比（取整误差 ≤1）', () => {
    const r = cropRect(3000, 4000, 295 / 413, { frac: 0.6, cx: 1500, cy: 2000 })
    expect(Math.abs(r.w / r.h - 295 / 413)).toBeLessThan(0.01)
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.x + r.w).toBeLessThanOrEqual(3000)
  })
  it('moveCrop 平移并贴边', () => {
    const s = { frac: 0.5, cx: 500, cy: 500 }
    expect(moveCrop(1000, 1000, 1, s, 100, -50)).toEqual({ frac: 0.5, cx: 600, cy: 450 })
    expect(moveCrop(1000, 1000, 1, s, 9999, 0).cx).toBe(750)
  })
  it('pinchFrac：拉开变大、捏合变小，夹紧；d0 无效原样返回', () => {
    expect(pinchFrac(0.5, 100, 200)).toBe(1)
    expect(pinchFrac(0.5, 100, 50)).toBe(0.25)
    expect(pinchFrac(0.3, 100, 10)).toBe(0.2)
    expect(pinchFrac(0.5, 0, 50)).toBe(0.5)
  })
  it('rectToPercent', () => {
    expect(rectToPercent({ x: 250, y: 0, w: 500, h: 1000 }, 1000, 1000)).toEqual({ left: 25, top: 0, width: 50, height: 100 })
  })
})

describe('颜色工具', () => {
  it('hexToRgb / rgbToHex', () => {
    expect(hexToRgb('#438edb')).toEqual([67, 142, 219])
    expect(hexToRgb('#fff')).toEqual([255, 255, 255])
    expect(hexToRgb('xyz')).toBeNull()
    expect(rgbToHex([67, 142, 219])).toBe('#438edb')
    expect(rgbToHex([300, -5, 0])).toBe('#ff0000')
  })
  it('colorDistance', () => {
    expect(colorDistance(WHITE, WHITE)).toBe(0)
    expect(colorDistance([0, 0, 0], [3, 4, 0])).toBe(5)
  })
  it('sampleColor 取窗口均值，边界不越界', () => {
    const { data, w, h } = rgba(['ww', 'ww'], { w: [10, 20, 30] })
    expect(sampleColor(data, w, h, 0, 0)).toEqual([10, 20, 30])
    expect(sampleColor(data, w, h, 99, 99)).toEqual([0, 0, 0])
  })
})

describe('backgroundMask', () => {
  const pal = { w: WHITE, k: BLACK }
  it('只抠与边缘相连的背景：人物内部的同色孤岛保留', () => {
    // 黑色环里包着一个白点，白点与外部背景不连通
    const { data, w, h } = rgba(['.....', '.kkk.', '.kwk.', '.kkk.', '.....'].map((r) => r.replace(/\./g, 'w')), pal)
    const m = backgroundMask(data, w, h, WHITE, 10, true)
    expect(m[2 * w + 2]).toBe(0)
    expect(m[0]).toBe(1)
    const all = backgroundMask(data, w, h, WHITE, 10, false)
    expect(all[2 * w + 2]).toBe(1)
  })
  it('容差外的颜色不算背景', () => {
    const { data, w, h } = rgba(['wwk'], pal)
    expect(Array.from(backgroundMask(data, w, h, WHITE, 10, true))).toEqual([1, 1, 0])
    expect(Array.from(backgroundMask(data, w, h, [250, 250, 250], 10, true))).toEqual([1, 1, 0])
  })
})

describe('featherAlpha', () => {
  it('背景恒 0；紧贴背景的前景出现中间值，内部前景 255', () => {
    // 5x5：左 2 列背景，右 3 列前景
    const w = 5
    const h = 5
    const mask = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < 2; x++) mask[y * w + x] = 1
    const a = featherAlpha(mask, w, h)
    expect(a[2 * w + 0]).toBe(0)
    expect(a[2 * w + 4]).toBe(255)
    expect(a[2 * w + 1]).toBe(0)
    expect(a[2 * w + 2]).toBeGreaterThan(0)
    expect(a[2 * w + 2]).toBeLessThan(255)
    expect(a[2 * w + 3]).toBe(255)
  })
  it('全背景 / 全前景', () => {
    expect(Array.from(featherAlpha(new Uint8Array(4).fill(1), 2, 2))).toEqual([0, 0, 0, 0])
    expect(Array.from(featherAlpha(new Uint8Array(4), 2, 2))).toEqual([255, 255, 255, 255])
  })
})

describe('replaceBackground', () => {
  it('白底换蓝底：背景变蓝，主体保留，alpha 全 255', () => {
    const pal = { w: WHITE, k: BLACK }
    const rows = ['wwwwwww', 'wwwwwww', 'wwkkkww', 'wwkkkww', 'wwkkkww', 'wwwwwww', 'wwwwwww']
    const { data, w, h } = rgba(rows, pal)
    const removed = replaceBackground(data, w, h, WHITE, 30, BLUE)
    expect(removed).toBe(49 - 9)
    // 左上角：背景 → 蓝
    expect([data[0], data[1], data[2], data[3]]).toEqual([0, 0, 255, 255])
    // 主体正中：仍为黑
    const c = (3 * w + 3) * 4
    expect([data[c], data[c + 1], data[c + 2]]).toEqual([0, 0, 0])
    // 主体边缘像素既不是纯蓝也不是纯黑（羽化过）
    const e = (2 * w + 2) * 4
    expect(data[e + 2]).toBeGreaterThan(0)
    expect(data[e + 2]).toBeLessThan(255)
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(255)
  })
  it('取色与图不符时没抠到东西（removed 为 0）', () => {
    const { data, w, h } = rgba(['kkk'], { k: BLACK })
    expect(replaceBackground(data, w, h, WHITE, 10, BLUE)).toBe(0)
    expect([data[0], data[1], data[2]]).toEqual([0, 0, 0])
  })
})
