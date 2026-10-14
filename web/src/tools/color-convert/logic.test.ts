import { describe, expect, it } from 'vitest'
import { AA_LARGE, AA_NORMAL, AAA_LARGE, AAA_NORMAL, buildPalette, contrastRatio, formatColor, hslToRgb, hsvToRgb, parseColor, readableOn, rgbToHsl, rgbToHsv, relativeLuminance, SCHEME_LABEL, wcagLevels, type PaletteScheme, type Rgba } from './logic'

/** 解析并取颜色，失败则抛出 */
function ok(s: string): Rgba {
  const r = parseColor(s)
  if (!r.ok) throw new Error(r.error)
  return r.color
}

describe('parseColor', () => {
  it('HEX 各位数，# 可省，大小写不敏感', () => {
    expect(ok('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(ok('3B6CF6')).toEqual({ r: 59, g: 108, b: 246, a: 1 })
    expect(ok('#0f08').a).toBeCloseTo(0.533, 3)
    expect(ok('#ff000080').a).toBeCloseTo(0.502, 3)
  })
  it('rgb 逗号、空格、百分数、斜杠透明度', () => {
    expect(ok('rgb(59, 108, 246)')).toEqual({ r: 59, g: 108, b: 246, a: 1 })
    expect(ok('rgb(59 108 246 / 50%)')).toEqual({ r: 59, g: 108, b: 246, a: 0.5 })
    expect(ok('rgba(100%, 0%, 0%, 0.25)')).toEqual({ r: 255, g: 0, b: 0, a: 0.25 })
  })
  it('hsl 与 hsv', () => {
    const c = ok('hsl(120, 100%, 50%)')
    expect([c.r, c.g, c.b].map(Math.round)).toEqual([0, 255, 0])
    const d = ok('hsv(0 100% 100%)')
    expect([d.r, d.g, d.b].map(Math.round)).toEqual([255, 0, 0])
    expect(ok('hsl(-120deg, 100%, 50%)').b).toBeCloseTo(255, 5)
  })
  it('颜色名', () => {
    expect(ok('Red')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })
  it('通道越界按范围截断', () => {
    expect(ok('rgb(300, -5, 10)')).toEqual({ r: 255, g: 0, b: 10, a: 1 })
  })
  it('非法输入给提示而不抛错', () => {
    for (const s of ['', '  ', '#12', '#gggggg', 'rgb(1,2)', 'rgb(a,b,c)', 'hello', 'rgb(1,2,3,x)', '#12345']) {
      const r = parseColor(s)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
    }
  })
})

describe('颜色空间转换', () => {
  it('已知值', () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 })
    expect(rgbToHsv({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 100, v: 100 })
    expect(rgbToHsl({ r: 128, g: 128, b: 128 }).s).toBe(0)
    expect(rgbToHsl({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, l: 0 })
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 })
  })
  it('RGB 与 HSL / HSV 来回转无累积误差（按步长遍历）', () => {
    for (let r = 0; r < 256; r += 15) {
      for (let g = 0; g < 256; g += 15) {
        for (let b = 0; b < 256; b += 15) {
          const a = hslToRgb(rgbToHsl({ r, g, b }))
          const v = hsvToRgb(rgbToHsv({ r, g, b }))
          expect([a.r, a.g, a.b]).toEqual([r, g, b].map((x) => expect.closeTo(x, 6)))
          expect([v.r, v.g, v.b]).toEqual([r, g, b].map((x) => expect.closeTo(x, 6)))
        }
      }
    }
  })
  it('HEX 字符串往返稳定', () => {
    for (const h of ['#000000', '#FFFFFF', '#3B6CF6', '#01FE7A', '#7F7F7F']) {
      expect(formatColor(ok(h)).hex).toBe(h)
      // 经 HSL 字符串（整数取整）再解析，每通道误差不超过 3
      const back = ok(formatColor(ok(h)).hsl)
      const orig = ok(h)
      expect(Math.abs(back.r - orig.r)).toBeLessThanOrEqual(3)
    }
  })
})

describe('formatColor', () => {
  it('输出各格式', () => {
    expect(formatColor({ r: 59, g: 108, b: 246, a: 1 })).toEqual({
      hex: '#3B6CF6',
      rgb: 'rgb(59, 108, 246)',
      hsl: 'hsl(224, 91%, 60%)',
      hsv: 'hsv(224, 76%, 96%)',
    })
  })
  it('带透明度时用 rgba / hsla / 8 位 HEX', () => {
    const f = formatColor({ r: 255, g: 0, b: 0, a: 0.5 })
    expect(f.hex).toBe('#FF000080')
    expect(f.rgb).toBe('rgba(255, 0, 0, 0.5)')
    expect(f.hsl).toBe('hsla(0, 100%, 50%, 0.5)')
  })
})

describe('readableOn', () => {
  it('亮底配黑字，暗底配白字', () => {
    expect(readableOn({ r: 255, g: 255, b: 255, a: 1 })).toBe('#000000')
    expect(readableOn({ r: 0, g: 0, b: 0, a: 1 })).toBe('#ffffff')
  })
})

describe('relativeLuminance', () => {
  it('黑 0，白 1，绿最亮', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10)
    expect(relativeLuminance({ r: 0, g: 255, b: 0 })).toBeCloseTo(0.7152, 4)
    expect(relativeLuminance({ r: 300, g: -5, b: 0 })).toBeCloseTo(0.2126, 4)
  })
})

describe('contrastRatio', () => {
  it('黑白 21，同色 1，顺序无关', () => {
    const k = { r: 0, g: 0, b: 0 }
    const w = { r: 255, g: 255, b: 255 }
    expect(contrastRatio(k, w)).toBeCloseTo(21, 6)
    expect(contrastRatio(w, k)).toBeCloseTo(21, 6)
    expect(contrastRatio(w, w)).toBe(1)
  })
  it('已知值：#777 配白约 4.48，#767676 配白约 4.54', () => {
    const w = { r: 255, g: 255, b: 255 }
    expect(contrastRatio({ r: 0x77, g: 0x77, b: 0x77 }, w)).toBeCloseTo(4.48, 2)
    expect(contrastRatio({ r: 0x76, g: 0x76, b: 0x76 }, w)).toBeCloseTo(4.54, 2)
  })
})

describe('wcagLevels', () => {
  it('阈值边界', () => {
    expect(wcagLevels(AA_NORMAL)).toEqual({ aaNormal: true, aaLarge: true, aaaNormal: false, aaaLarge: true })
    expect(wcagLevels(AA_NORMAL - 0.01).aaNormal).toBe(false)
    expect(wcagLevels(AA_LARGE - 0.01)).toEqual({ aaNormal: false, aaLarge: false, aaaNormal: false, aaaLarge: false })
    expect(wcagLevels(AAA_NORMAL).aaaNormal).toBe(true)
    expect(wcagLevels(AAA_LARGE).aaaLarge).toBe(true)
    expect(wcagLevels(21)).toEqual({ aaNormal: true, aaLarge: true, aaaNormal: true, aaaLarge: true })
  })
})

describe('buildPalette', () => {
  const red: Rgba = { r: 255, g: 0, b: 0, a: 1 }
  /** 取整后的 [r,g,b] */
  const rgb = (c: Rgba) => [c.r, c.g, c.b]
  it('互补：红与青', () => {
    expect(buildPalette(red, 'complementary').map(rgb)).toEqual([[255, 0, 0], [0, 255, 255]])
  })
  it('类似：基色在中间，色相 ±30', () => {
    const p = buildPalette(red, 'analogous')
    expect(p.length).toBe(3)
    expect(rgb(p[1])).toEqual([255, 0, 0])
    expect(rgb(p[0])).toEqual([255, 0, 128])
    expect(rgb(p[2])).toEqual([255, 128, 0])
  })
  it('三等分：红、绿、蓝', () => {
    expect(buildPalette(red, 'triadic').map(rgb)).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 255]])
  })
  it('分裂互补：色相 0 / 150 / 210', () => {
    const p = buildPalette(red, 'split')
    expect(p.length).toBe(3)
    expect(rgb(p[1])).toEqual([0, 255, 128])
    expect(rgb(p[2])).toEqual([0, 128, 255])
  })
  it('单色渐变：色相与饱和度不变，亮度递增', () => {
    const p = buildPalette({ r: 59, g: 108, b: 246, a: 1 }, 'mono')
    expect(p.length).toBe(5)
    const hsl = p.map(rgbToHsl)
    for (const x of hsl) {
      expect(x.h).toBeCloseTo(hsl[0].h, 0)
      expect(x.s).toBeGreaterThan(80)
    }
    expect(hsl.map((x) => Math.round(x.l))).toEqual([20, 35, 50, 65, 80])
  })
  it('负色相偏移回绕，透明度恒为 1，灰色保持灰色', () => {
    const p = buildPalette({ r: 128, g: 128, b: 128, a: 0.3 }, 'analogous')
    expect(p.every((c) => c.a === 1 && c.r === 128 && c.g === 128 && c.b === 128)).toBe(true)
    expect(buildPalette({ r: 255, g: 0, b: 128, a: 1 }, 'analogous')[2].r).toBeGreaterThan(0)
  })
  it('每个方案都有中文名', () => {
    for (const k of Object.keys(SCHEME_LABEL) as PaletteScheme[]) expect(SCHEME_LABEL[k].length).toBeGreaterThan(0)
  })
})
