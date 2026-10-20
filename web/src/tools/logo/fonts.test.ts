// 字体配置与文本渲染估算单测

import { describe, expect, it } from 'vitest'
import { estimateTextWidth, FONTS, getFont } from './fonts'
import type { FontId } from './types'

// 测试用常量定义
const TOTAL_FONTS_COUNT = 6
const TEST_FONT_ID_SANS_BOLD: FontId = 'sans-bold'
const TEST_FONT_ID_SANS: FontId = 'sans'
const TEST_FONT_ID_SERIF: FontId = 'serif'
const TEST_FONT_ID_SERIF_BOLD: FontId = 'serif-bold'
const TEST_FONT_ID_MONO: FontId = 'mono'
const TEST_FONT_ID_ROUNDED: FontId = 'rounded'
const TEST_FONT_ID_UNKNOWN = 'not-a-font-id'

// 文本宽度测试字号及字重常量
const TEST_FONT_SIZE_BASE = 16
const TEST_FONT_SIZE_LARGE = 24
const TEST_FONT_WEIGHT_NORMAL = 400
const TEST_FONT_WEIGHT_BOLD = 700
const TEST_SPACING_ZERO = 0
const TEST_SPACING_FIVE = 5
const ZERO_WIDTH = 0

// 样本文本常量
const SAMPLE_TEXT_SHORT = 'Ark'
const SAMPLE_TEXT_LONG = 'Arkli'
const SAMPLE_CHAR_CJK = '中'
const SAMPLE_CHAR_LATIN = 'A'

describe('字体定义列表 FONTS', () => {
  it('应当精确包含全部 6 个预设字体标识', () => {
    expect(FONTS).toHaveLength(TOTAL_FONTS_COUNT)

    const fontIds = FONTS.map(item => item.id)
    expect(fontIds).toContain(TEST_FONT_ID_SANS_BOLD)
    expect(fontIds).toContain(TEST_FONT_ID_SANS)
    expect(fontIds).toContain(TEST_FONT_ID_SERIF)
    expect(fontIds).toContain(TEST_FONT_ID_SERIF_BOLD)
    expect(fontIds).toContain(TEST_FONT_ID_MONO)
    expect(fontIds).toContain(TEST_FONT_ID_ROUNDED)
  })

  it('每一套字体均具备有效的中文展示名称、字体栈与字重', () => {
    for (const font of FONTS) {
      expect(font.name.length).toBeGreaterThan(0)
      expect(font.family.length).toBeGreaterThan(0)
      expect(font.weight).toBeGreaterThan(0)
    }
  })
})

describe('字体获取函数 getFont', () => {
  it('能够准确匹配并获取存在的各类型字体配置', () => {
    expect(getFont(TEST_FONT_ID_SANS).id).toBe(TEST_FONT_ID_SANS)
    expect(getFont(TEST_FONT_ID_SERIF_BOLD).id).toBe(TEST_FONT_ID_SERIF_BOLD)
    expect(getFont(TEST_FONT_ID_MONO).id).toBe(TEST_FONT_ID_MONO)
    expect(getFont(TEST_FONT_ID_ROUNDED).id).toBe(TEST_FONT_ID_ROUNDED)
  })

  it('传入不存在的字体标识时兜底回退至黑体粗体', () => {
    const fallback = getFont(TEST_FONT_ID_UNKNOWN)
    expect(fallback.id).toBe(TEST_FONT_ID_SANS_BOLD)
  })
})

describe('文本渲染宽度估算函数 estimateTextWidth', () => {
  it('空文本内容应当返回宽度 0', () => {
    expect(estimateTextWidth('', TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)).toBe(ZERO_WIDTH)
  })

  it('相同字号下 CJK 全角字符宽度应显著大于普通拉丁字母', () => {
    const cjkWidth = estimateTextWidth(SAMPLE_CHAR_CJK, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)
    const latinWidth = estimateTextWidth(SAMPLE_CHAR_LATIN, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)
    expect(cjkWidth).toBeGreaterThan(latinWidth)
  })

  it('字符数量增加时估算宽度单调递增', () => {
    const shortWidth = estimateTextWidth(SAMPLE_TEXT_SHORT, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)
    const longWidth = estimateTextWidth(SAMPLE_TEXT_LONG, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)
    expect(longWidth).toBeGreaterThan(shortWidth)
  })

  it('字号增大时估算宽度单调递增', () => {
    const baseWidth = estimateTextWidth(SAMPLE_TEXT_LONG, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)
    const largeWidth = estimateTextWidth(SAMPLE_TEXT_LONG, TEST_FONT_SIZE_LARGE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)
    expect(largeWidth).toBeGreaterThan(baseWidth)
  })

  it('多字符文本在字距增大时估算宽度单调递增', () => {
    const noSpacingWidth = estimateTextWidth(SAMPLE_TEXT_LONG, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)
    const spacedWidth = estimateTextWidth(SAMPLE_TEXT_LONG, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_FIVE)
    expect(spacedWidth).toBeGreaterThan(noSpacingWidth)
  })

  it('粗体状态（字重 ≥ 700）下估算宽度单调递增', () => {
    const normalWidth = estimateTextWidth(SAMPLE_TEXT_LONG, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)
    const boldWidth = estimateTextWidth(SAMPLE_TEXT_LONG, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_BOLD, TEST_SPACING_ZERO)
    expect(boldWidth).toBeGreaterThan(normalWidth)

    const normalCjkWidth = estimateTextWidth(SAMPLE_CHAR_CJK, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)
    const boldCjkWidth = estimateTextWidth(SAMPLE_CHAR_CJK, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_BOLD, TEST_SPACING_ZERO)
    expect(boldCjkWidth).toBeGreaterThan(normalCjkWidth)
  })

  it('单字符在不同字距下宽度保持一致（字距不作用于单字符）', () => {
    const singleNoSpacing = estimateTextWidth(SAMPLE_CHAR_LATIN, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_ZERO)
    const singleSpaced = estimateTextWidth(SAMPLE_CHAR_LATIN, TEST_FONT_SIZE_BASE, TEST_FONT_WEIGHT_NORMAL, TEST_SPACING_FIVE)
    expect(singleSpaced).toBe(singleNoSpacing)
  })
})
