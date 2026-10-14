import { describe, expect, it } from 'vitest'
import { clampRatio, DEFAULT_RATIO, MAX_SIDE, ratioText, validateFuse } from './logic'

/** 一张合格的图 */
const OK = { url: 'blob:x', width: 800, height: 600 }

describe('clampRatio', () => {
  it('夹紧、对齐步进、非数字给默认值', () => {
    expect(clampRatio(1.7)).toBe(1)
    expect(clampRatio(-3)).toBe(0)
    expect(clampRatio(0.33)).toBe(0.35)
    expect(clampRatio(0.5)).toBe(0.5)
    expect(clampRatio(NaN)).toBe(DEFAULT_RATIO)
  })
})

describe('ratioText', () => {
  it('两侧合计 100%', () => {
    expect(ratioText(0.3)).toBe('图 A 70% · 图 B 30%')
    expect(ratioText(0)).toBe('图 A 100% · 图 B 0%')
    expect(ratioText(2)).toBe('图 A 0% · 图 B 100%')
  })
})

describe('validateFuse', () => {
  it('缺图', () => {
    expect(validateFuse(null, null, 0.5)).toBe('请先选择图 A')
    expect(validateFuse(OK, null, 0.5)).toBe('请再选择图 B')
    expect(validateFuse(OK, { ...OK, url: '' }, 0.5)).toBe('请再选择图 B')
  })
  it('尺寸过大指出是哪一张', () => {
    expect(validateFuse({ ...OK, width: MAX_SIDE + 1 }, OK, 0.5)).toBe('图 A尺寸过大，请先缩小')
    expect(validateFuse(OK, { ...OK, height: MAX_SIDE + 1 }, 0.5)).toBe('图 B尺寸过大，请先缩小')
  })
  it('比例越界、非数字', () => {
    expect(validateFuse(OK, OK, 1.2)).toBe('融合比例需在 0~1 之间')
    expect(validateFuse(OK, OK, NaN)).toBe('融合比例需在 0~1 之间')
  })
  it('通过返回 null（含边界 0 与 1）', () => {
    expect(validateFuse(OK, OK, 0)).toBeNull()
    expect(validateFuse(OK, OK, 1)).toBeNull()
  })
})
