import { describe, expect, it } from 'vitest'
import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE } from '@/shared/image-calc'
import { BG_PRESETS, clampRadius, frameLayout, gradientLine, type FrameOptions } from './logic'

/** 默认参数 */
const base: FrameOptions = { style: 'card', padPct: 10, radiusPct: 5, cutout: 'none' }

describe('clampRadius', () => {
  it('不超过短边一半，不为负', () => {
    expect(clampRadius(100, 40, 60)).toBe(20)
    expect(clampRadius(-5, 40, 60)).toBe(0)
    expect(clampRadius(7.6, 100, 100)).toBe(8)
  })
})

describe('gradientLine', () => {
  it('90 度从左到右', () => {
    expect(gradientLine(100, 100, 90)).toEqual({ x0: 0, y0: 50, x1: 100, y1: 50 })
  })
  it('0 度从下到上', () => {
    expect(gradientLine(100, 200, 0)).toEqual({ x0: 50, y0: 200, x1: 50, y1: 0 })
  })
  it('135 度覆盖整个矩形对角', () => {
    const g = gradientLine(100, 100, 135)
    expect(g.x0).toBeCloseTo(0)
    expect(g.y0).toBeCloseTo(0)
    expect(g.x1).toBeCloseTo(100)
    expect(g.y1).toBeCloseTo(100)
  })
})

describe('BG_PRESETS', () => {
  it('色值合法', () => {
    for (const p of BG_PRESETS) {
      expect(p.c1).toMatch(/^#[0-9a-f]{6}$/i)
      expect(p.c2).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('frameLayout 纯卡片', () => {
  it('画布 = 截图 + 两侧边距，截图与外壳重合', () => {
    const l = frameLayout(1000, 500, base)
    expect(l.width).toBe(1200)
    expect(l.height).toBe(700)
    expect(l.screen).toEqual({ x: 100, y: 100, w: 1000, h: 500 })
    expect(l.device).toEqual(l.screen)
    expect(l.deviceRadius).toBe(50)
    expect(l.screenRadius).toBe(50)
    expect(l.scale).toBe(1)
    expect(l.bar).toBeUndefined()
    expect(l.cutout).toBeUndefined()
  })
  it('边距为 0 时画布等于截图', () => {
    const l = frameLayout(400, 300, { ...base, padPct: 0 })
    expect([l.width, l.height]).toEqual([400, 300])
  })
})

describe('frameLayout 手机壳', () => {
  const opts: FrameOptions = { style: 'phone', padPct: 10, radiusPct: 8, cutout: 'none' }
  it('黑边包在截图外，内圆角 = 外圆角 - 黑边', () => {
    const l = frameLayout(1000, 2000, opts)
    const bezel = 35
    expect(l.screen.x - l.device.x).toBe(bezel)
    expect(l.device.w).toBe(1000 + bezel * 2)
    expect(l.device.h).toBe(2000 + bezel * 2)
    expect(l.deviceRadius).toBe(80)
    expect(l.screenRadius).toBe(80 - bezel)
    expect(l.width).toBe(l.device.w + 200)
  })
  it('小图黑边不低于下限', () => {
    const l = frameLayout(100, 200, opts)
    expect(l.screen.x - l.device.x).toBe(6)
  })
  it('刘海居中在屏幕顶', () => {
    const l = frameLayout(1000, 2000, { ...opts, cutout: 'notch' })
    const c = l.cutout!
    expect(c.kind).toBe('notch')
    expect(c.rect.y).toBe(l.screen.y)
    expect(c.rect.x + c.rect.w / 2).toBeCloseTo(l.screen.x + l.screen.w / 2, 0)
    expect(c.dot).toBeUndefined()
  })
  it('挖孔是居中小圆，在屏幕内', () => {
    const l = frameLayout(1000, 2000, { ...opts, cutout: 'punch' })
    const d = l.cutout!.dot!
    expect(d.x).toBe(l.screen.x + 500)
    expect(d.y - d.r).toBeGreaterThan(l.screen.y)
    expect(d.r).toBe(18)
  })
})

describe('frameLayout 浏览器窗口', () => {
  const opts: FrameOptions = { style: 'browser', padPct: 5, radiusPct: 2, cutout: 'none' }
  it('顶栏在截图上方，整体高度含顶栏', () => {
    const l = frameLayout(1000, 600, opts)
    const bar = l.bar!
    expect(bar.rect.h).toBe(60)
    expect(l.screen.y).toBe(l.device.y + 60)
    expect(l.device.h).toBe(660)
    expect(l.screenRadius).toBe(0)
  })
  it('三点与地址栏都落在顶栏内且不重叠', () => {
    const l = frameLayout(1000, 600, opts)
    const bar = l.bar!
    expect(bar.dots).toHaveLength(3)
    for (const d of bar.dots) {
      expect(d.y - d.r).toBeGreaterThanOrEqual(bar.rect.y)
      expect(d.y + d.r).toBeLessThanOrEqual(bar.rect.y + bar.rect.h)
    }
    expect(bar.dots[2].x + bar.dots[2].r).toBeLessThan(bar.pill.x)
    expect(bar.pill.x + bar.pill.w).toBeLessThanOrEqual(bar.rect.x + bar.rect.w)
    expect(bar.pill.w).toBeGreaterThan(0)
  })
  it('窄图顶栏不低于下限', () => {
    expect(frameLayout(200, 300, opts).bar!.rect.h).toBe(32)
  })
})

describe('frameLayout 超限缩放', () => {
  it('超出单边上限时整体缩小，且结果不超限', () => {
    const l = frameLayout(1000, 20000, base)
    expect(l.scale).toBeLessThan(1)
    expect(l.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE)
    expect(l.screen.w / l.screen.h).toBeCloseTo(1000 / 20000, 1)
  })
  it('超出总像素上限时缩小', () => {
    const l = frameLayout(12000, 12000, base)
    expect(l.scale).toBeLessThan(1)
    expect(l.width * l.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS)
  })
  it('未超限 scale 为 1', () => {
    expect(frameLayout(800, 600, base).scale).toBe(1)
  })
})
