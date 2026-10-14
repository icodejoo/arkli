import { describe, expect, it } from 'vitest'
import { blinkPeriod, clampNum, cleanText, fitFontSize, FONT_MAX, FONT_MIN, invertColor, PRESETS, TEXT_MAX } from './logic'

describe('fitFontSize', () => {
  it('线性测量取到最大可行值', () => {
    expect(fitFontSize(400, 300, (fs) => fs * 2)).toBe(150)
  })
  it('放不下时返回下限', () => {
    expect(fitFontSize(400, 10, (fs) => fs * 2)).toBe(FONT_MIN)
  })
  it('很宽松时封顶', () => {
    expect(fitFontSize(400, 99999, (fs) => fs)).toBe(FONT_MAX)
  })
  it('文字越多字号越小（宽度影响换行）', () => {
    const lines = (n: number) => (fs: number, w: number) => Math.ceil((n * fs) / w) * fs * 1.25
    expect(fitFontSize(360, 640, lines(20))).toBeLessThan(fitFontSize(360, 640, lines(4)))
  })
  it('容器无效返回下限', () => {
    expect(fitFontSize(0, 100, (fs) => fs)).toBe(FONT_MIN)
  })
})

describe('clampNum', () => {
  it('夹取与非法值', () => {
    expect(clampNum(5, 0, 3)).toBe(3)
    expect(clampNum(-1, 0, 3)).toBe(0)
    expect(clampNum(NaN, 1, 3)).toBe(1)
  })
})

describe('blinkPeriod', () => {
  it('频率换周期并夹取', () => {
    expect(blinkPeriod(2)).toBe(0.5)
    expect(blinkPeriod(0.5)).toBe(2)
    expect(blinkPeriod(10)).toBe(0.5)
    expect(blinkPeriod(0)).toBe(2)
  })
})

describe('cleanText', () => {
  it('换行归一并截断', () => {
    expect(cleanText('a\r\nb\rc')).toBe('a\nb\nc')
    expect(cleanText('x'.repeat(TEXT_MAX + 5)).length).toBe(TEXT_MAX)
  })
})

describe('invertColor', () => {
  it('取反', () => {
    expect(invertColor('#000000')).toBe('#ffffff')
    expect(invertColor('#ffeb3b')).toBe('#0014c4')
  })
  it('格式不对原样返回', () => {
    expect(invertColor('red')).toBe('red')
  })
})

describe('PRESETS', () => {
  it('颜色合法且名称唯一', () => {
    const names = new Set(PRESETS.map((p) => p.name))
    expect(names.size).toBe(PRESETS.length)
    for (const p of PRESETS) {
      expect(p.fg).toMatch(/^#[0-9a-f]{6}$/i)
      expect(p.bg).toMatch(/^#[0-9a-f]{6}$/i)
      expect(p.fg).not.toBe(p.bg)
    }
  })
})
