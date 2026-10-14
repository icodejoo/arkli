import { describe, expect, it } from 'vitest'
import {
  addStop,
  checkSize,
  colorAt,
  gradientCss,
  linearLine,
  normalizeStops,
  parseHex,
  radialCircle,
  removeStop,
  rgbToHex,
  SIZE_PRESETS,
  STOP_MAX,
  STOP_MIN,
  type ColorStop,
} from './logic'

/** 黑到白两色标 */
const BW: ColorStop[] = [
  { color: '#000000', pos: 0 },
  { color: '#ffffff', pos: 100 },
]

describe('checkSize', () => {
  it('合法尺寸并取整', () => {
    expect(checkSize(1080.4, 1920)).toEqual({ ok: true, message: '', width: 1080, height: 1920 })
  })
  it('非正数、NaN 不可用', () => {
    expect(checkSize(0, 100).ok).toBe(false)
    expect(checkSize(100, -3).ok).toBe(false)
    expect(checkSize(NaN, 100).ok).toBe(false)
  })
  it('超过画布上限不可用', () => {
    expect(checkSize(20000, 100).ok).toBe(false)
    expect(checkSize(10000, 10000).ok).toBe(false)
  })
  it('所有预设都合法', () => {
    for (const p of SIZE_PRESETS) expect(checkSize(p.width, p.height).ok).toBe(true)
  })
})

describe('parseHex / rgbToHex', () => {
  it('三位与六位', () => {
    expect(parseHex('#f80')).toEqual([255, 136, 0])
    expect(parseHex('FF8800')).toEqual([255, 136, 0])
    expect(parseHex('#12')).toBeNull()
  })
  it('回写并夹紧', () => {
    expect(rgbToHex([255, 0, 128])).toBe('#ff0080')
    expect(rgbToHex([300, -1, 0.4])).toBe('#ff0000')
  })
})

describe('normalizeStops', () => {
  it('夹紧、排序、坏颜色回退黑', () => {
    const out = normalizeStops([
      { color: '#fff', pos: 120 },
      { color: 'oops', pos: -5 },
    ])
    expect(out).toEqual([
      { color: '#000000', pos: 0 },
      { color: '#ffffff', pos: 100 },
    ])
  })
  it('同位置保持原顺序，不改入参', () => {
    const src = [
      { color: '#111111', pos: 50 },
      { color: '#222222', pos: 50 },
    ]
    expect(normalizeStops(src).map((s) => s.color)).toEqual(['#111111', '#222222'])
    expect(src[0].color).toBe('#111111')
  })
})

describe('colorAt', () => {
  it('中点插值', () => {
    expect(colorAt(BW, 50)).toBe('#808080')
    expect(colorAt(BW, 25)).toBe('#404040')
  })
  it('端点与超出范围', () => {
    expect(colorAt(BW, 0)).toBe('#000000')
    expect(colorAt(BW, 100)).toBe('#ffffff')
    expect(colorAt(BW, -10)).toBe('#000000')
    expect(colorAt(BW, 150)).toBe('#ffffff')
  })
  it('多色标分段，色标乱序也行', () => {
    const stops: ColorStop[] = [
      { color: '#0000ff', pos: 100 },
      { color: '#ff0000', pos: 0 },
      { color: '#00ff00', pos: 50 },
    ]
    expect(colorAt(stops, 50)).toBe('#00ff00')
    expect(colorAt(stops, 25)).toBe('#808000')
  })
  it('首色标不在 0 时前段取首色', () => {
    expect(colorAt([{ color: '#102030', pos: 40 }, { color: '#ffffff', pos: 90 }], 10)).toBe('#102030')
  })
})

describe('linearLine', () => {
  it('90 度：从左到右穿过中心', () => {
    const l = linearLine(200, 100, 90)
    expect(l.x0).toBeCloseTo(0)
    expect(l.x1).toBeCloseTo(200)
    expect(l.y0).toBeCloseTo(50)
    expect(l.y1).toBeCloseTo(50)
  })
  it('0 度：从下到上', () => {
    const l = linearLine(200, 100, 0)
    expect(l.y0).toBeCloseTo(100)
    expect(l.y1).toBeCloseTo(0)
  })
  it('45 度：渐变线长度使角点正好落在两端', () => {
    const l = linearLine(100, 100, 45)
    expect(Math.hypot(l.x1 - l.x0, l.y1 - l.y0)).toBeCloseTo(Math.hypot(100, 100))
  })
})

describe('radialCircle', () => {
  it('圆心居中，半径到最远角', () => {
    expect(radialCircle(600, 800)).toEqual({ cx: 300, cy: 400, r: 500 })
  })
})

describe('gradientCss', () => {
  it('线性', () => {
    expect(gradientCss('linear', BW, 90)).toBe('linear-gradient(90deg, #000000 0%, #ffffff 100%)')
  })
  it('径向', () => {
    expect(gradientCss('radial', BW, 0)).toBe('radial-gradient(circle farthest-corner at 50% 50%, #000000 0%, #ffffff 100%)')
  })
})

describe('addStop / removeStop', () => {
  it('新增放在最大空隙中点，颜色为该处渐变色', () => {
    const out = addStop(BW)
    expect(out).toHaveLength(3)
    expect(out[1]).toEqual({ color: '#808080', pos: 50 })
  })
  it('空隙选最大的一段', () => {
    const out = addStop([
      { color: '#000000', pos: 0 },
      { color: '#111111', pos: 10 },
      { color: '#ffffff', pos: 100 },
    ])
    expect(out.map((s) => s.pos)).toEqual([0, 10, 55, 100])
  })
  it('到上限不再加，到下限不再删', () => {
    let s = BW
    for (let i = 0; i < 10; i++) s = addStop(s)
    expect(s).toHaveLength(STOP_MAX)
    expect(removeStop(BW, 0)).toHaveLength(STOP_MIN)
  })
  it('删除指定下标', () => {
    const three = addStop(BW)
    expect(removeStop(three, 1).map((s) => s.pos)).toEqual([0, 100])
    expect(removeStop(three, 9)).toHaveLength(3)
  })
})
