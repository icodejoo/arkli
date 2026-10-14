import type { Rect } from '@/shared/image-calc'
import type { Palette, PaletteColor } from './data'

/** Lab 颜色 [L, a, b] */
export type Lab = [number, number, number]

/** 带 Lab 值的调色板条目（预先算好，匹配时不重复转换） */
export interface LabEntry {
  /** 原调色板颜色 */
  color: PaletteColor
  /** Lab 值 */
  lab: Lab
}

/** 用量统计行 */
export interface UsageRow {
  /** 在调色板中的下标 */
  index: number
  /** 色号 */
  code: string
  /** 颜色名 */
  name: string
  /** 色值 */
  hex: string
  /** 用量（格数） */
  count: number
}

/** 图纸布局 */
export interface PatternLayout {
  /** 单格边长（像素） */
  cell: number
  /** 四周留给行列号的边距 */
  margin: number
  /** 图纸区宽高（含边距，不含图例） */
  width: number
  /** 图纸区高 */
  height: number
}

/** 图例布局 */
export interface LegendLayout {
  /** 列数 */
  cols: number
  /** 行数 */
  rows: number
  /** 单项宽 */
  itemW: number
  /** 单项高 */
  itemH: number
  /** 图例总高（含标题） */
  height: number
}

/** 常用网格规格 */
export const GRID_PRESETS = [29, 52]
/** 自定义网格边长范围 */
export const GRID_MIN = 5
export const GRID_MAX = 100
/** 降采样时每格在中间画布上占的像素边长（超采样后再取均值，画质更稳） */
export const SAMPLE_PER_CELL = 4
/** 粗线间隔（每 N 格一条，方便数格子） */
export const MAJOR_EVERY = 10

/** D65 参考白点 */
const WHITE_X = 0.95047
const WHITE_Y = 1
const WHITE_Z = 1.08883
/** sRGB 线性化阈值与 Lab 分段常数 */
const SRGB_THRESHOLD = 0.04045
const LAB_EPSILON = 216 / 24389
const LAB_KAPPA = 24389 / 27
/** 单格边长分档：格数 ≤ 32 / ≤ 64 / 更大 */
const CELL_SMALL = 40
const CELL_MID = 32
const CELL_LARGE = 24
const GRID_SMALL = 32
const GRID_MID = 64
/** 行列号边距占单格边长的倍数 */
const MARGIN_RATIO = 1
/** 图例每项宽（单格倍数）与高（单格倍数）、标题高（单格倍数） */
const LEGEND_ITEM_W = 6
const LEGEND_ITEM_H = 1.2
const LEGEND_TITLE_H = 2
/** 前景色选择的亮度阈值（0~255） */
const LUMA_THRESHOLD = 150
/** 亮度权重 */
const LUMA_R = 0.299
const LUMA_G = 0.587
const LUMA_B = 0.114
/** 通道最大值 */
const CHANNEL_MAX = 255

/**
 * #rrggbb 转 [r, g, b]。
 *
 * @param hex 色值，可带或不带 #
 * @returns 三通道 0~255；格式不对返回 [0, 0, 0]
 * @example hexToRgb('#ff8000') // [255, 128, 0]
 */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & CHANNEL_MAX, (n >> 8) & CHANNEL_MAX, n & CHANNEL_MAX]
}

/** sRGB 通道（0~255）转线性值 */
function linear(c: number): number {
  const v = c / CHANNEL_MAX
  return v <= SRGB_THRESHOLD ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** Lab 的 f 函数 */
function labF(t: number): number {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116
}

/**
 * sRGB 转 CIE Lab（D65）。
 *
 * @param r 红 0~255
 * @param g 绿 0~255
 * @param b 蓝 0~255
 * @returns [L, a, b]
 * @example srgbToLab(255, 255, 255) // 约 [100, 0, 0]
 */
export function srgbToLab(r: number, g: number, b: number): Lab {
  const lr = linear(r)
  const lg = linear(g)
  const lb = linear(b)
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / WHITE_X
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / WHITE_Y
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / WHITE_Z
  const fx = labF(x)
  const fy = labF(y)
  const fz = labF(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/**
 * 预算调色板每色的 Lab 值。
 *
 * @param palette 调色板
 * @returns 带 Lab 的条目，顺序与调色板一致
 */
export function buildLabPalette(palette: Palette): LabEntry[] {
  return palette.colors.map((color) => ({ color, lab: srgbToLab(...hexToRgb(color.hex)) }))
}

/**
 * 在 Lab 空间找最近色（欧氏距离，即 ΔE76）。
 *
 * @param lab 目标颜色
 * @param entries 预算好的调色板
 * @returns 最近色在调色板中的下标；调色板为空返回 -1
 * @example nearestIndex(srgbToLab(250, 250, 250), buildLabPalette(p)) // 白色的下标
 */
export function nearestIndex(lab: Lab, entries: LabEntry[]): number {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i].lab
    const d = (lab[0] - e[0]) ** 2 + (lab[1] - e[1]) ** 2 + (lab[2] - e[2]) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * 网格边长夹到合法范围。
 *
 * @param n 输入值（可能是小数或 NaN）
 * @returns 整数，范围 [GRID_MIN, GRID_MAX]
 */
export function clampGrid(n: number): number {
  if (!isFinite(n)) return GRID_PRESETS[0]
  return Math.max(GRID_MIN, Math.min(GRID_MAX, Math.round(n)))
}

/**
 * 居中裁成正方形的源矩形（保持比例，不拉伸）。
 *
 * @param w 源图宽
 * @param h 源图高
 * @returns 裁剪矩形
 * @example cropSquare(400, 300) // { x: 50, y: 0, w: 300, h: 300 }
 */
export function cropSquare(w: number, h: number): Rect {
  const s = Math.min(w, h)
  return { x: Math.floor((w - s) / 2), y: Math.floor((h - s) / 2), w: s, h: s }
}

/**
 * 把 RGBA 像素按格取平均，降采样成 cols × rows 个颜色。透明像素按白底合成。
 *
 * @param data RGBA 像素（长度 width*height*4）
 * @param width 图宽
 * @param height 图高
 * @param cols 目标列数
 * @param rows 目标行数
 * @returns 长度 cols*rows*3 的 RGB 数组，按行优先
 * @example downsample(rgba, 8, 8, 2, 2) // 每个 4×4 块取均值
 */
export function downsample(data: ArrayLike<number>, width: number, height: number, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(cols * rows * 3)
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor((cy * height) / rows)
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / rows))
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * width) / cols)
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / cols))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const p = (y * width + x) * 4
          const a = data[p + 3] / CHANNEL_MAX
          r += data[p] * a + CHANNEL_MAX * (1 - a)
          g += data[p + 1] * a + CHANNEL_MAX * (1 - a)
          b += data[p + 2] * a + CHANNEL_MAX * (1 - a)
          n++
        }
      }
      const o = (cy * cols + cx) * 3
      if (n) {
        out[o] = Math.round(r / n)
        out[o + 1] = Math.round(g / n)
        out[o + 2] = Math.round(b / n)
      }
    }
  }
  return out
}

/**
 * 把每格颜色映射到调色板，得到每格的色板下标。
 *
 * @param rgb 长度 N*3 的 RGB 数组
 * @param entries 预算好的调色板
 * @returns 长度 N 的下标数组
 */
export function mapToPalette(rgb: ArrayLike<number>, entries: LabEntry[]): Uint16Array {
  const n = Math.floor(rgb.length / 3)
  const out = new Uint16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.max(0, nearestIndex(srgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]), entries))
  return out
}

/**
 * 统计各色用量，按用量从多到少排序，用量相同按色号。
 *
 * @param indices 每格的色板下标
 * @param palette 调色板
 * @returns 用量行（不含用量为 0 的颜色）
 * @example usageStats(new Uint16Array([0, 0, 1]), palette) // [{ code: 'A01', count: 2 }, ...]
 */
export function usageStats(indices: ArrayLike<number>, palette: Palette): UsageRow[] {
  const counts = new Map<number, number>()
  for (let i = 0; i < indices.length; i++) counts.set(indices[i], (counts.get(indices[i]) ?? 0) + 1)
  const rows: UsageRow[] = []
  counts.forEach((count, index) => {
    const c = palette.colors[index]
    if (c) rows.push({ index, code: c.code, name: c.name, hex: c.hex, count })
  })
  return rows.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1))
}

/**
 * 在给定底色上选黑或白作文字色。
 *
 * @param hex 底色
 * @returns `#000000` 或 `#ffffff`
 * @example contrastColor('#ffffff') // '#000000'
 */
export function contrastColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return LUMA_R * r + LUMA_G * g + LUMA_B * b > LUMA_THRESHOLD ? '#000000' : '#ffffff'
}

/**
 * 按格数选单格边长（格多则格小，保证整张图不至于过大）。
 *
 * @param n 网格边长
 * @returns 单格像素边长
 */
export function chooseCell(n: number): number {
  return n <= GRID_SMALL ? CELL_SMALL : n <= GRID_MID ? CELL_MID : CELL_LARGE
}

/**
 * 图纸区布局：n×n 格加四周行列号边距。
 *
 * @param n 网格边长
 * @returns 单格、边距、图纸区宽高
 * @example patternLayout(29) // { cell: 40, margin: 40, width: 1240, height: 1240 }
 */
export function patternLayout(n: number): PatternLayout {
  const cell = chooseCell(n)
  const margin = Math.round(cell * MARGIN_RATIO)
  const side = n * cell + margin * 2
  return { cell, margin, width: side, height: side }
}

/**
 * 图例布局：按图纸宽度排成多列。
 *
 * @param width 图纸宽（图例沿用同宽）
 * @param count 颜色数
 * @param cell 单格边长（用来推导尺寸）
 * @returns 列数、行数、单项尺寸与总高；没有颜色时高为 0
 */
export function legendLayout(width: number, count: number, cell: number): LegendLayout {
  const itemW = Math.round(cell * LEGEND_ITEM_W)
  const itemH = Math.round(cell * LEGEND_ITEM_H)
  if (count <= 0) return { cols: 1, rows: 0, itemW, itemH, height: 0 }
  const cols = Math.max(1, Math.floor(width / itemW))
  const rows = Math.ceil(count / cols)
  return { cols, rows, itemW, itemH, height: Math.round(cell * LEGEND_TITLE_H) + rows * itemH }
}

/**
 * 校验调色板：色号唯一、色值合法、至少一色。
 *
 * @param palette 调色板
 * @returns 问题列表，空数组表示通过
 * @example validatePalette({ id: 'x', name: 'x', colors: [] }) // ['调色板为空']
 */
export function validatePalette(palette: Palette): string[] {
  const errs: string[] = []
  if (!palette.colors.length) errs.push('调色板为空')
  const seen = new Set<string>()
  for (const c of palette.colors) {
    if (seen.has(c.code)) errs.push(`色号重复：${c.code}`)
    seen.add(c.code)
    if (!/^#[0-9a-f]{6}$/i.test(c.hex)) errs.push(`色值不合法：${c.code} ${c.hex}`)
  }
  return errs
}
