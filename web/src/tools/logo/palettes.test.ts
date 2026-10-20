// 配色方案与对比度计算单测

import { describe, expect, it } from 'vitest'
import { applyOverrides, contrastRatio, getPalette, PALETTES } from './palettes'
import type { Palette } from './types'

// 测试用常量定义
const TOTAL_PALETTES_COUNT = 14
const COLOR_BLACK = '#000000'
const COLOR_WHITE = '#ffffff'
const TEST_PALETTE_ID_TECH_BLUE = 'tech-blue'
const TEST_PALETTE_ID_CYBER_NEON = 'cyber-neon'
const TEST_PALETTE_ID_UNKNOWN = 'non-existent-id'
const CUSTOM_PRIMARY_VALID = '#123456'
const CUSTOM_PRIMARY_UPPERCASE = '#AABBCC'
const CUSTOM_PRIMARY_UPPERCASE_LOWER = '#aabbcc'
const CUSTOM_PRIMARY_INVALID = 'not-a-color'
const MIN_TEXT_CONTRAST = 4.5
const MIN_PRIMARY_CONTRAST = 3.0
const CONTRAST_RATIO_SAME = 1.0
const CONTRAST_RATIO_MAX = 21.0
const CONTRAST_PRECISION_DIGITS = 4

// 标签集合常量
const VALID_TAGS = new Set([
  'warm',
  'cool',
  'dark',
  'light',
  'vivid',
  'calm',
  'natural',
  'elegant',
])

const TAG_DARK = 'dark'
const TAG_LIGHT = 'light'
const TAG_WARM = 'warm'
const TAG_COOL = 'cool'
const TAG_NATURAL = 'natural'
const TAG_ELEGANT = 'elegant'
const TAG_VIVID = 'vivid'
const TAG_CALM = 'calm'

// 小写十六进制格式检测正则
const HEX_LOWER_REGEX = /^#[0-9a-f]{6}$/
// kebab-case 格式检测正则
const KEBAB_CASE_REGEX = /^[a-z]+(-[a-z]+)*$/

describe('配色方案集合 PALETTES', () => {
  it('应当恰好包含 14 套精选配色方案', () => {
    expect(PALETTES).toHaveLength(TOTAL_PALETTES_COUNT)
  })

  it('所有配色的 id 均应符合 kebab-case 小写短横线命名规范', () => {
    for (const p of PALETTES) {
      expect(p.id).toMatch(KEBAB_CASE_REGEX)
    }
  })

  it('所有配色的标签均应属于合法预设标签词表', () => {
    for (const p of PALETTES) {
      expect(p.tags.length).toBeGreaterThan(0)
      for (const tag of p.tags) {
        expect(VALID_TAGS.has(tag)).toBe(true)
      }
    }
  })

  it('所有配色的各通道颜色值均必须为严格小写的 #rrggbb 格式', () => {
    for (const p of PALETTES) {
      expect(p.primary).toMatch(HEX_LOWER_REGEX)
      expect(p.secondary).toMatch(HEX_LOWER_REGEX)
      expect(p.bg).toMatch(HEX_LOWER_REGEX)
      expect(p.text).toMatch(HEX_LOWER_REGEX)
    }
  })

  it('每套配色的文字与背景对比度必须 ≥ 4.5，主色与背景对比度必须 ≥ 3.0', () => {
    for (const p of PALETTES) {
      const textContrast = contrastRatio(p.text, p.bg)
      const primaryContrast = contrastRatio(p.primary, p.bg)

      expect(textContrast).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
      expect(primaryContrast).toBeGreaterThanOrEqual(MIN_PRIMARY_CONTRAST)
    }
  })

  it('应当包含约 5 套深色背景、约 5 套浅色背景及 4 套中间色背景', () => {
    const darkPalettes = PALETTES.filter(p => p.tags.includes(TAG_DARK))
    const lightPalettes = PALETTES.filter(p => p.tags.includes(TAG_LIGHT))
    const midPalettes = PALETTES.filter(p => !p.tags.includes(TAG_DARK) && !p.tags.includes(TAG_LIGHT))

    expect(darkPalettes).toHaveLength(5)
    expect(lightPalettes).toHaveLength(5)
    expect(midPalettes).toHaveLength(4)
  })

  it('风格标签应当全面覆盖暖、冷、自然、高级、鲜艳、沉稳', () => {
    const allTags = new Set(PALETTES.flatMap(p => p.tags))
    expect(allTags.has(TAG_WARM)).toBe(true)
    expect(allTags.has(TAG_COOL)).toBe(true)
    expect(allTags.has(TAG_NATURAL)).toBe(true)
    expect(allTags.has(TAG_ELEGANT)).toBe(true)
    expect(allTags.has(TAG_VIVID)).toBe(true)
    expect(allTags.has(TAG_CALM)).toBe(true)
  })
})

describe('对比度计算函数 contrastRatio', () => {
  it('相同颜色的对比度必须为 1.0', () => {
    expect(contrastRatio(COLOR_BLACK, COLOR_BLACK)).toBeCloseTo(CONTRAST_RATIO_SAME, CONTRAST_PRECISION_DIGITS)
    expect(contrastRatio(COLOR_WHITE, COLOR_WHITE)).toBeCloseTo(CONTRAST_RATIO_SAME, CONTRAST_PRECISION_DIGITS)
  })

  it('纯黑与纯白的对比度必须为 21.0', () => {
    expect(contrastRatio(COLOR_BLACK, COLOR_WHITE)).toBeCloseTo(CONTRAST_RATIO_MAX, CONTRAST_PRECISION_DIGITS)
    expect(contrastRatio(COLOR_WHITE, COLOR_BLACK)).toBeCloseTo(CONTRAST_RATIO_MAX, CONTRAST_PRECISION_DIGITS)
  })

  it('计算对比度时应当不受输入颜色参数的前后顺序影响', () => {
    const colorA = '#123456'
    const colorB = '#abcdef'
    expect(contrastRatio(colorA, colorB)).toBeCloseTo(contrastRatio(colorB, colorA), CONTRAST_PRECISION_DIGITS)
  })
})

describe('配色获取函数 getPalette', () => {
  it('能够准确匹配并获取存在的配色方案', () => {
    const p1 = getPalette(TEST_PALETTE_ID_TECH_BLUE)
    expect(p1.id).toBe(TEST_PALETTE_ID_TECH_BLUE)

    const p2 = getPalette(TEST_PALETTE_ID_CYBER_NEON)
    expect(p2.id).toBe(TEST_PALETTE_ID_CYBER_NEON)
  })

  it('传入不存在的标识时应当兜底返回第一套默认配色', () => {
    const fallback = getPalette(TEST_PALETTE_ID_UNKNOWN)
    expect(fallback).toBe(PALETTES[0])
    expect(fallback.id).toBe(TEST_PALETTE_ID_TECH_BLUE)
  })
})

describe('覆盖及反色处理函数 applyOverrides', () => {
  const basePalette: Palette = {
    id: 'test-palette',
    name: '测试配色',
    tags: [TAG_LIGHT, TAG_CALM],
    primary: '#1a1a1a',
    secondary: '#6c757d',
    bg: '#f8f9fa',
    text: '#212529',
  }

  it('合法自定义主色能够覆盖原主色并统一转换为小写', () => {
    const res = applyOverrides(basePalette, CUSTOM_PRIMARY_UPPERCASE)
    expect(res.primary).toBe(CUSTOM_PRIMARY_UPPERCASE_LOWER)
    expect(res.bg).toBe(basePalette.bg)
    expect(res.text).toBe(basePalette.text)
  })

  it('非法自定义主色将被忽略，保留原主色', () => {
    const res = applyOverrides(basePalette, CUSTOM_PRIMARY_INVALID)
    expect(res.primary).toBe(basePalette.primary)
  })

  it('反色时对调主色与背景色，并自动选择对比度最高的文字色以确保可读性', () => {
    const res = applyOverrides(basePalette, undefined, true)
    // 对调背景与主色
    expect(res.bg).toBe(basePalette.primary)
    expect(res.primary).toBe(basePalette.bg)

    // 文字色应取原 text 与原 bg 中与新背景对比度更高者
    const crText = contrastRatio(basePalette.text, res.bg)
    const crBg = contrastRatio(basePalette.bg, res.bg)
    const expectedText = crText >= crBg ? basePalette.text : basePalette.bg
    expect(res.text).toBe(expectedText)
    expect(contrastRatio(res.text, res.bg)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })

  it('同时传入主色覆盖与反色时，新背景色应为覆盖后的主色', () => {
    const res = applyOverrides(basePalette, CUSTOM_PRIMARY_VALID, true)
    expect(res.bg).toBe(CUSTOM_PRIMARY_VALID)
    expect(res.primary).toBe(basePalette.bg)
  })

  it('调用该函数不会对原始配色对象造成任何修改变更', () => {
    const originalPrimary = basePalette.primary
    const originalBg = basePalette.bg
    const originalText = basePalette.text

    applyOverrides(basePalette, '#ff0000', true)

    expect(basePalette.primary).toBe(originalPrimary)
    expect(basePalette.bg).toBe(originalBg)
    expect(basePalette.text).toBe(originalText)
  })
})
