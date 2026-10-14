import { describe, expect, it } from 'vitest'
import {
  clampContrast,
  composePhantom,
  CONTRAST_DEFAULT,
  CONTRAST_MAX,
  CONTRAST_MIN,
  coverRect,
  DARK_CEIL,
  displayOn,
  LIGHT_FLOOR,
  luma,
  phantomPixel,
} from './logic'

/** 白底、黑底亮度 */
const WHITE = 255
const BLACK = 0
/** 8 位量化带来的容许误差 */
const TOL = 2

/** 单色 RGBA 像素 */
function px(v: number): number[] {
  return [v, v, v, 255]
}

describe('luma', () => {
  it('纯色', () => {
    expect(luma(255, 255, 255)).toBeCloseTo(255)
    expect(luma(0, 0, 0)).toBe(0)
    expect(luma(255, 0, 0)).toBeCloseTo(76.245)
  })
})

describe('clampContrast', () => {
  it('夹紧与非数字', () => {
    expect(clampContrast(99)).toBe(CONTRAST_MAX)
    expect(clampContrast(0)).toBe(CONTRAST_MIN)
    expect(clampContrast(NaN)).toBe(CONTRAST_DEFAULT)
  })
})

describe('phantomPixel', () => {
  it('白底≈表图映射值，黑底≈里图映射值（遍历若干亮度组合）', () => {
    for (const a of [0, 40, 100, 128, 200, 255]) {
      for (const b of [0, 30, 90, 128, 180, 255]) {
        const p = phantomPixel(a, b, 1)
        const top = LIGHT_FLOOR + (a * (255 - LIGHT_FLOOR)) / 255
        const bottom = (b * DARK_CEIL) / 255
        expect(Math.abs(displayOn(p.gray, p.alpha, WHITE) - top)).toBeLessThanOrEqual(TOL)
        expect(Math.abs(displayOn(p.gray, p.alpha, BLACK) - bottom)).toBeLessThanOrEqual(TOL)
      }
    }
  })
  it('表图最亮、里图最暗时完全透明', () => {
    expect(phantomPixel(255, 0, 1)).toEqual({ gray: 0, alpha: 0 })
  })
  it('表图最暗、里图最亮时 alpha 取到最大（表图下限=里图上限，不透明）', () => {
    expect(phantomPixel(0, 255, 1).alpha).toBe(255)
  })
  it('里图对比度越大，暗部越暗、亮部越亮', () => {
    const lowDark = displayOn(phantomPixel(128, 60, 1).gray, phantomPixel(128, 60, 1).alpha, BLACK)
    const highDark = displayOn(phantomPixel(128, 60, 2).gray, phantomPixel(128, 60, 2).alpha, BLACK)
    expect(highDark).toBeLessThan(lowDark)
    const lowLight = displayOn(phantomPixel(128, 200, 1).gray, phantomPixel(128, 200, 1).alpha, BLACK)
    const highLight = displayOn(phantomPixel(128, 200, 2).gray, phantomPixel(128, 200, 2).alpha, BLACK)
    expect(highLight).toBeGreaterThan(lowLight)
  })
})

describe('composePhantom', () => {
  it('小图：白底近似表图（映射后），黑底近似里图（映射后）', () => {
    const surface = new Uint8ClampedArray([...px(255), ...px(100), ...px(200), ...px(30)])
    const inner = new Uint8ClampedArray([...px(0), ...px(120), ...px(255), ...px(60)])
    const out = composePhantom(surface, inner, { contrast: 1 })
    expect(out).toHaveLength(16)
    for (let i = 0; i < 4; i++) {
      const g = out[i * 4]
      const a = out[i * 4 + 3]
      // 灰度输出：三通道相等
      expect(out[i * 4 + 1]).toBe(g)
      expect(out[i * 4 + 2]).toBe(g)
      const top = LIGHT_FLOOR + (surface[i * 4] * (255 - LIGHT_FLOOR)) / 255
      const bottom = (inner[i * 4] * DARK_CEIL) / 255
      expect(Math.abs(displayOn(g, a, WHITE) - top)).toBeLessThanOrEqual(TOL)
      expect(Math.abs(displayOn(g, a, BLACK) - bottom)).toBeLessThanOrEqual(TOL)
    }
  })
  it('彩色输入按亮度处理', () => {
    const out = composePhantom([255, 0, 0, 255], [0, 0, 255, 255], { contrast: 1 })
    const top = LIGHT_FLOOR + (luma(255, 0, 0) * (255 - LIGHT_FLOOR)) / 255
    expect(Math.abs(displayOn(out[0], out[3], WHITE) - top)).toBeLessThanOrEqual(TOL)
  })
  it('长度不一致抛错', () => {
    expect(() => composePhantom([0, 0, 0, 255], [0, 0, 0, 255, 0, 0, 0, 255], { contrast: 1 })).toThrow()
  })
})

describe('displayOn', () => {
  it('不透明显示自身，全透明显示背景', () => {
    expect(displayOn(80, 255, WHITE)).toBe(80)
    expect(displayOn(80, 0, WHITE)).toBe(255)
    expect(displayOn(100, 128, BLACK)).toBeCloseTo(50.2, 1)
  })
})

describe('coverRect', () => {
  it('源更宽：左右裁', () => {
    expect(coverRect(200, 100, 100, 100)).toEqual({ x: 50, y: 0, w: 100, h: 100 })
  })
  it('源更高：上下裁', () => {
    expect(coverRect(100, 200, 100, 100)).toEqual({ x: 0, y: 50, w: 100, h: 100 })
  })
  it('同比例不裁，放大也成立', () => {
    expect(coverRect(50, 50, 100, 100)).toEqual({ x: 0, y: 0, w: 50, h: 50 })
  })
})
