// Android WebView 字体回退关系与已知限制说明：
// 1. Android 系统中文字体高度依赖系统内置的 Noto Sans CJK SC（思源黑体），大部分机型并未预装中文字体库中的圆体或标准宋体。
// 2. 系统的中文字重档位相对有限，通常仅能稳定呈现常规体（400）与粗体（700），极端细体或特粗体往往由渲染引擎合成。
// 3. 针对圆体（rounded），在移动端缺失真实圆体字库时，会无缝回退至系统无衬线黑体栈，以保证排版不发生字体丢失或乱码。

import type { FontId } from './types'

/**
 * 字体配置项接口定义
 */
export interface FontItem {
  /** 字体唯一标识 */
  id: FontId
  /** 字体中文显示名称 */
  name: string
  /** 字体族栈定义 */
  family: string
  /** 字体字重粗细 */
  weight: number
  /** 是否为斜体 */
  italic?: boolean
}

// 字体栈字符串常量定义
const SANS_FAMILY = '"Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif'
const SERIF_FAMILY = '"Noto Serif CJK SC","Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif'
const MONO_FAMILY = '"Roboto Mono","Noto Sans Mono CJK SC","Courier New",monospace'
const ROUNDED_FAMILY = `"PingFang SC Rounded","Hiragino Sans Rounded","Quicksand",${SANS_FAMILY}`

// 字重与尺寸相关常量
const WEIGHT_BOLD = 700
const WEIGHT_NORMAL = 400

// 默认回退字体标识
const DEFAULT_FONT_ID: FontId = 'sans-bold'

// 文本宽度估算比例常量（用于自动缩字号的粗略估算）
const CJK_EM = 1.0
const LATIN_EM = 0.58
const NARROW_EM = 0.3
const BOLD_SCALE = 1.06
const NORMAL_SCALE = 1.0
const CHAR_COUNT_SINGLE = 1
const ZERO_WIDTH = 0
const MAX_ASCII_CODE = 255
const SPACE_CHAR = ' '

// 窄字符集合（窄英文字母与常见半角标点）
const NARROW_CHAR_SET = new Set(['i', 'l', 'I', '.', ',', ':', ';', '!', '\'', '|', '`', '-'])

// CJK 及全角标点符号检测正则
const CJK_REGEX = /[\u1100-\u11ff\u2e80-\ua4cf\ua800-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u4e00-\u9fa5]/

/**
 * 支持的 6 套系统预设字体列表
 */
export const FONTS: FontItem[] = [
  {
    id: 'sans-bold',
    name: '黑体粗',
    family: SANS_FAMILY,
    weight: WEIGHT_BOLD,
  },
  {
    id: 'sans',
    name: '黑体常规',
    family: SANS_FAMILY,
    weight: WEIGHT_NORMAL,
  },
  {
    id: 'serif',
    name: '宋体常规',
    family: SERIF_FAMILY,
    weight: WEIGHT_NORMAL,
  },
  {
    id: 'serif-bold',
    name: '宋体粗',
    family: SERIF_FAMILY,
    weight: WEIGHT_BOLD,
  },
  {
    id: 'mono',
    name: '等宽代码',
    family: MONO_FAMILY,
    weight: WEIGHT_NORMAL,
  },
  {
    id: 'rounded',
    name: '柔和圆体',
    family: ROUNDED_FAMILY,
    weight: WEIGHT_BOLD,
  },
]

/**
 * 根据标识获取字体项，未匹配时回退到黑体粗体
 *
 * @param id 字体标识
 * @returns 匹配的字体配置项对象
 * @example
 * ```ts
 * const font = getFont('sans-bold')
 * ```
 */
export function getFont(id: FontId | string): FontItem {
  const matched = FONTS.find(item => item.id === id)
  if (matched) {
    return matched
  }
  return FONTS.find(item => item.id === DEFAULT_FONT_ID) || FONTS[0]
}

/**
 * 估算给定文本在特定字号、字重与字距下的渲染总宽度（纯函数粗略估算，用于自动缩字号）
 *
 * @param text 待测量的文本内容
 * @param size 字体大小（像素值）
 * @param weight 字体粗细权重
 * @param spacingPx 字符间距（像素值）
 * @returns 估算的文本渲染宽度（像素值）
 * @example
 * ```ts
 * const width = estimateTextWidth('Arkli', 16, 700, 2)
 * ```
 */
export function estimateTextWidth(
  text: string,
  size: number,
  weight: number,
  spacingPx: number
): number {
  if (!text || text.length === 0) {
    return ZERO_WIDTH
  }

  const isBold = weight >= WEIGHT_BOLD
  const boldRatio = isBold ? BOLD_SCALE : NORMAL_SCALE

  let totalEm = 0
  for (const ch of text) {
    if (ch === SPACE_CHAR) {
      totalEm += NARROW_EM * boldRatio
    } else if (NARROW_CHAR_SET.has(ch)) {
      totalEm += NARROW_EM * boldRatio
    } else if (CJK_REGEX.test(ch) || ch.charCodeAt(0) > MAX_ASCII_CODE) {
      totalEm += CJK_EM * boldRatio
    } else {
      totalEm += LATIN_EM * boldRatio
    }
  }

  const baseWidth = totalEm * size
  const spacingTotal = text.length > CHAR_COUNT_SINGLE
    ? (text.length - CHAR_COUNT_SINGLE) * spacingPx
    : ZERO_WIDTH

  return baseWidth + spacingTotal
}
