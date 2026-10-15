// 取色器的纯逻辑：HEX 与 HSV 互转、预设色。颜色解析与转换复用 color-convert。
import { formatColor, hsvToRgb, parseColor, rgbToHsv, type Hsv } from '@/tools/color-convert/logic'

/** 预设色：黑白灰 + 常见彩色，点一下直接选 */
export const COLOR_PRESETS = [
  '#ffffff', '#f2f3f5', '#c8c9cc', '#969799', '#323233', '#000000',
  '#ee0a24', '#ff976a', '#ffd21e', '#07c160', '#1989fa', '#7232dd',
]

/** 色相最大值，色相条的满格 */
export const HUE_MAX = 360
/** 饱和度、明度的满格 */
export const PERCENT_MAX = 100

/**
 * 把用户输入规整成小写 `#rrggbb`，忽略透明度。
 *
 * @param input 用户输入，如 `fff`、`#3B6CF6`、`rgb(59,108,246)`
 * @returns 规整后的 HEX；认不出返回 null
 * @example
 * toHex6('#FFF') // '#ffffff'
 */
export function toHex6(input: string): string | null {
  const r = parseColor(input)
  if (!r.ok) return null
  return formatColor({ ...r.color, a: 1 }).hex.toLowerCase()
}

/**
 * HEX 转 HSV，认不出时回落白色。
 *
 * @param hex 颜色字符串
 * @returns HSV（h 0~360，s/v 0~100）
 */
export function hexToHsv(hex: string): Hsv {
  const r = parseColor(hex)
  return rgbToHsv(r.ok ? r.color : { r: 255, g: 255, b: 255 })
}

/**
 * HSV 转小写 `#rrggbb`。
 *
 * @param hsv HSV（h 0~360，s/v 0~100）
 * @example
 * hsvToHex({ h: 0, s: 100, v: 100 }) // '#ff0000'
 */
export function hsvToHex(hsv: Hsv): string {
  return formatColor({ ...hsvToRgb(hsv), a: 1 }).hex.toLowerCase()
}

/**
 * 把指针在某个方框内的位置换成 0~1 的比例，越界夹住。
 *
 * @param pos 指针坐标
 * @param start 方框起点
 * @param size 方框边长，0 时返回 0
 */
export function ratioIn(pos: number, start: number, size: number): number {
  if (size <= 0) return 0
  return Math.min(1, Math.max(0, (pos - start) / size))
}

/**
 * 放大镜气泡该放手指上方还是下方：上方放得下就放上方，否则放下方。
 *
 * @param y 指针在取色区内的纵坐标（取色区顶边为 0）
 * @param size 气泡直径
 * @param gap 气泡与手指的间距
 * @param room 取色区上方还有多少可显示的空间（弹层标题等），默认 0
 * @returns 放上方为 true，放下方为 false
 * @example
 * loupeAbove(10, 64, 16) // false
 */
export function loupeAbove(y: number, size: number, gap: number, room = 0): boolean {
  return y - gap - size >= -room
}

/**
 * 在背景色上该用黑字还是白字，保证气泡里的 HEX 看得清。
 *
 * @param hex 背景色
 * @returns 浅色背景返回黑色，深色背景返回白色；认不出按白底处理（返回黑色）
 * @example
 * readableOn('#000000') // '#ffffff'
 */
export function readableOn(hex: string): '#000000' | '#ffffff' {
  const r = parseColor(hex)
  if (!r.ok) return '#000000'
  const { r: R, g: G, b: B } = r.color
  return (R * 299 + G * 587 + B * 114) / 1000 > 140 ? '#000000' : '#ffffff'
}
