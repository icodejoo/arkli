import { describe, expect, it } from 'vitest'
import {
  anchorCenter,
  clamp,
  FONT_MIN_PX,
  fontPx,
  layoutWatermark,
  MAX_TILES,
  rotatedBox,
  tileCenters,
  type LayoutOptions,
} from './logic'

/** 默认布局参数，测试里按需覆盖 */
const base: LayoutOptions = { mode: 'single', position: 4, rotation: 0, gapX: 50, gapY: 50, stagger: false }

describe('fontPx', () => {
  it('按短边百分比，横竖图一致', () => {
    expect(fontPx(1000, 2000, 5)).toBe(50)
    expect(fontPx(2000, 1000, 5)).toBe(50)
  })
  it('不小于下限', () => {
    expect(fontPx(100, 100, 1)).toBe(FONT_MIN_PX)
  })
})

describe('clamp', () => {
  it('夹紧与非数字', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-5, 0, 1)).toBe(0)
    expect(clamp(NaN, 3, 9)).toBe(3)
  })
})

describe('rotatedBox', () => {
  it('0 度不变，90 度宽高互换', () => {
    expect(rotatedBox(100, 20, 0)).toEqual({ w: 100, h: 20 })
    const r = rotatedBox(100, 20, 90)
    expect(r.w).toBeCloseTo(20)
    expect(r.h).toBeCloseTo(100)
  })
  it('45 度外接盒相等', () => {
    const r = rotatedBox(100, 20, 45)
    expect(r.w).toBeCloseTo(r.h)
    expect(r.w).toBeCloseTo(120 / Math.SQRT2)
  })
})

describe('anchorCenter', () => {
  it('九宫格四角与中心', () => {
    expect(anchorCenter(0, 1000, 800, 200, 100, 20)).toEqual({ x: 120, y: 70 })
    expect(anchorCenter(2, 1000, 800, 200, 100, 20)).toEqual({ x: 880, y: 70 })
    expect(anchorCenter(4, 1000, 800, 200, 100, 20)).toEqual({ x: 500, y: 400 })
    expect(anchorCenter(6, 1000, 800, 200, 100, 20)).toEqual({ x: 120, y: 730 })
    expect(anchorCenter(8, 1000, 800, 200, 100, 20)).toEqual({ x: 880, y: 730 })
  })
  it('边中点只在一个轴上贴边', () => {
    expect(anchorCenter(1, 1000, 800, 200, 100, 20)).toEqual({ x: 500, y: 70 })
    expect(anchorCenter(5, 1000, 800, 200, 100, 20)).toEqual({ x: 880, y: 400 })
  })
  it('盒子比画布大时居中；越界位置按居中', () => {
    expect(anchorCenter(0, 100, 100, 300, 50, 5)).toEqual({ x: 50, y: 5 + 25 })
    expect(anchorCenter(99, 1000, 800, 200, 100, 20)).toEqual({ x: 500, y: 400 })
  })
})

describe('tileCenters', () => {
  it('不旋转时点都在画布及边缘范围内，间距等于格子', () => {
    const pts = tileCenters(1000, 600, 200, 100, 0, false, 0)
    expect(pts.length).toBeGreaterThan(0)
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1000)
    }
    const rowY = pts.filter((p) => p.y === 300).map((p) => p.x).sort((a, b) => a - b)
    expect(rowY[1] - rowY[0]).toBe(200)
  })
  it('旋转后仍能铺满画布四角附近', () => {
    const pts = tileCenters(1000, 1000, 150, 80, 30, false, 80)
    const near = (x: number, y: number) => pts.some((p) => Math.hypot(p.x - x, p.y - y) < 150)
    expect(near(0, 0) && near(1000, 0) && near(0, 1000) && near(1000, 1000)).toBe(true)
  })
  it('错开半格：相邻行 x 偏移半个格宽', () => {
    const pts = tileCenters(1000, 1000, 200, 100, 0, true, 0)
    const r0 = pts.filter((p) => Math.abs(p.y - 500) < 0.001).map((p) => p.x)
    const r1 = pts.filter((p) => Math.abs(p.y - 600) < 0.001).map((p) => p.x)
    expect(r0).toContain(500)
    expect(r1).toContain(600)
  })
  it('数量有上限', () => {
    expect(tileCenters(16000, 16000, 10, 10, 0, false, 0).length).toBe(MAX_TILES)
  })
})

describe('layoutWatermark', () => {
  it('单个模式返回一个点', () => {
    const pts = layoutWatermark(1000, 800, 200, 40, base)
    expect(pts).toEqual([{ x: 500, y: 400 }])
  })
  it('单个模式贴角时外接盒不出画布', () => {
    const [p] = layoutWatermark(1000, 800, 200, 40, { ...base, position: 8, rotation: 30 })
    const box = rotatedBox(200, 48, 30)
    expect(p.x + box.w / 2).toBeLessThanOrEqual(1000)
    expect(p.y + box.h / 2).toBeLessThanOrEqual(800)
  })
  it('平铺：竖图与横图（同短边同字号）数量相同，密度一致', () => {
    const tile: LayoutOptions = { ...base, mode: 'tile', rotation: -30 }
    const fs = fontPx(1000, 2000, 4)
    const a = layoutWatermark(1000, 2000, fs * 5, fs, tile).length
    const b = layoutWatermark(2000, 1000, fs * 5, fs, tile).length
    expect(Math.abs(a - b) / a).toBeLessThan(0.1)
    // 面积翻倍，数量应约为方图的两倍
    const sq = layoutWatermark(1000, 1000, fs * 5, fs, tile).length
    expect(a / sq).toBeGreaterThan(1.6)
    expect(a / sq).toBeLessThan(2.4)
  })
  it('间距越大，数量越少', () => {
    const tight = layoutWatermark(1000, 1000, 200, 40, { ...base, mode: 'tile', gapX: 10, gapY: 10 }).length
    const loose = layoutWatermark(1000, 1000, 200, 40, { ...base, mode: 'tile', gapX: 200, gapY: 200 }).length
    expect(loose).toBeLessThan(tight)
  })
})
