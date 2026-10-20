// 配色方案定义与对比度计算工具函数

import type { Palette } from './types'

// 风格标签常量
const TAG_WARM = 'warm'
const TAG_COOL = 'cool'
const TAG_DARK = 'dark'
const TAG_LIGHT = 'light'
const TAG_VIVID = 'vivid'
const TAG_CALM = 'calm'
const TAG_NATURAL = 'natural'
const TAG_ELEGANT = 'elegant'

// 常用颜色常量
const COLOR_WHITE = '#ffffff'
const COLOR_OFF_WHITE = '#f8f9fa'

// 相对对比度与亮度计算常数
const WCAG_LUMINANCE_OFFSET = 0.05
const SRGB_LOW_THRESHOLD = 0.04045
const SRGB_LOW_DIVISOR = 12.92
const SRGB_HIGH_OFFSET = 0.055
const SRGB_HIGH_DIVISOR = 1.055
const SRGB_EXPONENT = 2.4
const RED_WEIGHT = 0.2126
const GREEN_WEIGHT = 0.7152
const BLUE_WEIGHT = 0.0722
const MAX_CHANNEL_VALUE = 255

// 十六进制颜色正则及解析常量
const HEX_COLOR_REGEX = /^#[0-9a-f]{6}$/i
const HEX_PREFIX = '#'
const RED_START = 0
const GREEN_START = 2
const BLUE_START = 4
const CHANNEL_LENGTH = 2
const RADIX_HEX = 16

/**
 * 14 套精选预设配色方案
 */
export const PALETTES: Palette[] = [
  // 浅色背景组（约 5 套）
  {
    id: 'tech-blue',
    name: '科技蓝',
    tags: [TAG_LIGHT, TAG_COOL, TAG_CALM],
    primary: '#0066cc',
    secondary: '#38bdf8',
    bg: '#f0f7ff',
    text: '#0c2340',
  },
  {
    id: 'minimal-light',
    name: '极简素雅',
    tags: [TAG_LIGHT, TAG_CALM],
    primary: '#1a1a1a',
    secondary: '#6c757d',
    bg: COLOR_OFF_WHITE,
    text: '#212529',
  },
  {
    id: 'fresh-mint',
    name: '清凉薄荷',
    tags: [TAG_LIGHT, TAG_NATURAL, TAG_COOL],
    primary: '#059669',
    secondary: '#34d399',
    bg: '#f0fdf4',
    text: '#064e3b',
  },
  {
    id: 'coral-sand',
    name: '珊瑚暖沙',
    tags: [TAG_LIGHT, TAG_WARM],
    primary: '#ea580c',
    secondary: '#fb923c',
    bg: '#fff7ed',
    text: '#431407',
  },
  {
    id: 'rose-crimson',
    name: '玫瑰绯红',
    tags: [TAG_LIGHT, TAG_VIVID, TAG_WARM],
    primary: '#e11d48',
    secondary: '#fb7185',
    bg: '#fff1f2',
    text: '#4c0519',
  },

  // 深色背景组（约 5 套）
  {
    id: 'obsidian-gold',
    name: '黑金尊享',
    tags: [TAG_DARK, TAG_ELEGANT],
    primary: '#d4af37',
    secondary: '#f5e6b3',
    bg: '#121212',
    text: '#f0f0f0',
  },
  {
    id: 'cyber-neon',
    name: '赛博霓虹',
    tags: [TAG_DARK, TAG_VIVID, TAG_COOL],
    primary: '#00f0ff',
    secondary: '#ff007f',
    bg: '#0f1026',
    text: COLOR_WHITE,
  },
  {
    id: 'deep-purple',
    name: '幽邃紫罗兰',
    tags: [TAG_DARK, TAG_VIVID],
    primary: '#b76dfb',
    secondary: '#e0aaff',
    bg: '#1a0f2e',
    text: COLOR_WHITE,
  },
  {
    id: 'navy-slate',
    name: '藏青石板',
    tags: [TAG_DARK, TAG_CALM, TAG_COOL],
    primary: '#4ea8de',
    secondary: '#90e0ef',
    bg: '#151e28',
    text: COLOR_OFF_WHITE,
  },
  {
    id: 'emerald-gold',
    name: '祖母绿金',
    tags: [TAG_DARK, TAG_ELEGANT, TAG_NATURAL],
    primary: '#e2b755',
    secondary: '#84dcc6',
    bg: '#0a1f18',
    text: '#f5f7f6',
  },

  // 中间色背景组（4 套）
  {
    id: 'warm-coffee',
    name: '暖意咖啡',
    tags: [TAG_WARM, TAG_ELEGANT],
    primary: '#5c3317',
    secondary: '#8b5e34',
    bg: '#e6d5c3',
    text: '#2b1810',
  },
  {
    id: 'nordic-gray',
    name: '北欧冷灰',
    tags: [TAG_COOL, TAG_CALM],
    primary: '#1e40af',
    secondary: '#475569',
    bg: '#cbd5e1',
    text: '#0f172a',
  },
  {
    id: 'forest-green',
    name: '森林绿意',
    tags: [TAG_NATURAL, TAG_CALM],
    primary: '#164e35',
    secondary: '#3a7d5c',
    bg: '#cfe1d6',
    text: '#0b261a',
  },
  {
    id: 'sunset-orange',
    name: '日落暖橙',
    tags: [TAG_WARM, TAG_VIVID],
    primary: '#c2410c',
    secondary: '#ea580c',
    bg: '#fed7aa',
    text: '#3d1300',
  },
]

/**
 * 计算单个通道的 sRGB 线性相对亮度
 *
 * @param channelValue 通道整型值，范围 0 至 255
 * @returns 归一化后的线性亮度数值
 */
function channelToLinear(channelValue: number): number {
  const normalized = channelValue / MAX_CHANNEL_VALUE
  if (normalized <= SRGB_LOW_THRESHOLD) {
    return normalized / SRGB_LOW_DIVISOR
  }
  return Math.pow((normalized + SRGB_HIGH_OFFSET) / SRGB_HIGH_DIVISOR, SRGB_EXPONENT)
}

/**
 * 计算十六进制颜色的相对亮度
 *
 * @param hex 十六进制颜色字符串，如 #ffffff
 * @returns 相对亮度数值，范围在 0 至 1 之间
 */
function calculateLuminance(hex: string): number {
  const clean = hex.startsWith(HEX_PREFIX) ? hex.slice(1) : hex
  const r = parseInt(clean.substring(RED_START, RED_START + CHANNEL_LENGTH), RADIX_HEX) || 0
  const g = parseInt(clean.substring(GREEN_START, GREEN_START + CHANNEL_LENGTH), RADIX_HEX) || 0
  const b = parseInt(clean.substring(BLUE_START, BLUE_START + CHANNEL_LENGTH), RADIX_HEX) || 0

  const rLinear = channelToLinear(r)
  const gLinear = channelToLinear(g)
  const bLinear = channelToLinear(b)

  return RED_WEIGHT * rLinear + GREEN_WEIGHT * gLinear + BLUE_WEIGHT * bLinear
}

/**
 * 计算两个十六进制颜色之间的 WCAG 相对亮度对比度比值
 *
 * @param a 第一个颜色值，格式为 #rrggbb
 * @param b 第二个颜色值，格式为 #rrggbb
 * @returns 相对对比度比值，范围在 1 到 21 之间
 * @example
 * ```ts
 * const ratio = contrastRatio('#000000', '#ffffff')
 * ```
 */
export function contrastRatio(a: string, b: string): number {
  const lumA = calculateLuminance(a)
  const lumB = calculateLuminance(b)
  const max = Math.max(lumA, lumB)
  const min = Math.min(lumA, lumB)
  return (max + WCAG_LUMINANCE_OFFSET) / (min + WCAG_LUMINANCE_OFFSET)
}

/**
 * 根据标识获取配色方案，若未找到则回退至第一套默认配色
 *
 * @param id 配色方案标识
 * @returns 对应的配色方案对象
 * @example
 * ```ts
 * const p = getPalette('tech-blue')
 * ```
 */
export function getPalette(id: string): Palette {
  const found = PALETTES.find(item => item.id === id)
  if (found) {
    return found
  }
  return PALETTES[0]
}

/**
 * 应用主色覆盖及反色配置，返回全新派生的配色对象
 *
 * @param p 基础配色方案
 * @param primaryOverride 自定义主色，格式为 #rrggbb，非法则忽略
 * @param invert 是否反转背景色与主色
 * @returns 包含新颜色配置的独立配色对象
 * @example
 * ```ts
 * const next = applyOverrides(palette, '#ff0000', true)
 * ```
 */
export function applyOverrides(
  p: Palette,
  primaryOverride?: string,
  invert?: boolean
): Palette {
  let effectivePrimary = p.primary
  if (primaryOverride && HEX_COLOR_REGEX.test(primaryOverride)) {
    effectivePrimary = primaryOverride.toLowerCase()
  }

  if (invert) {
    const nextBg = effectivePrimary
    const nextPrimary = p.bg
    const crText = contrastRatio(p.text, nextBg)
    const crBg = contrastRatio(p.bg, nextBg)
    const nextText = crText >= crBg ? p.text : p.bg

    return {
      ...p,
      primary: nextPrimary,
      bg: nextBg,
      text: nextText,
      tags: [...p.tags],
    }
  }

  return {
    ...p,
    primary: effectivePrimary,
    tags: [...p.tags],
  }
}
