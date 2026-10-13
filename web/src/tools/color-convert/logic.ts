// 颜色转换：解析 HEX / rgb() / hsl() / hsv() / 基础颜色名，输出 HEX、RGB、HSL、HSV
// 内部统一用 RGB（0~255，可带小数）+ 透明度（0~1），格式化时才取整

/** RGBA 颜色：r/g/b 为 0~255，a 为 0~1 */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** HSL：h 为 0~360，s/l 为 0~100 */
export interface Hsl {
  h: number
  s: number
  l: number
}

/** HSV：h 为 0~360，s/v 为 0~100 */
export interface Hsv {
  h: number
  s: number
  v: number
}

/** 解析结果：成功带颜色，失败带中文提示 */
export type ParseResult = { ok: true; color: Rgba } | { ok: false; error: string }

/** 基础颜色名（CSS 常用 17 个，完整 148 个暂不收） */
export const NAMED_COLORS: Record<string, string> = {
  black: '#000000', silver: '#c0c0c0', gray: '#808080', white: '#ffffff',
  maroon: '#800000', red: '#ff0000', purple: '#800080', fuchsia: '#ff00ff',
  green: '#008000', lime: '#00ff00', olive: '#808000', yellow: '#ffff00',
  navy: '#000080', blue: '#0000ff', teal: '#008080', aqua: '#00ffff', orange: '#ffa500',
}

/** 通道最大值 */
const MAX_CHANNEL = 255
/** 提示：无法识别 */
const ERR_UNKNOWN = '认不出这个颜色，试试 #3b6cf6、rgb(59,108,246)、hsl(224,91%,60%)'

/** 把数值限制在区间内 */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 四舍五入保留 n 位小数 */
function round(v: number, n = 0): number {
  const k = 10 ** n
  return Math.round(v * k) / k
}

/**
 * 解析一个颜色字符串。支持 `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`（# 可省）、
 * `rgb()/rgba()`（逗号或空格分隔，通道可为百分数）、`hsl()/hsla()`、`hsv()`、基础颜色名。
 *
 * @param input 用户输入
 * @returns 成功返回 Rgba；无法识别返回错误提示
 * @example
 * parseColor('#f00') // { ok: true, color: { r: 255, g: 0, b: 0, a: 1 } }
 */
export function parseColor(input: string): ParseResult {
  const s = input.trim().toLowerCase()
  if (!s) return { ok: false, error: '请输入颜色' }
  if (NAMED_COLORS[s]) return parseHex(NAMED_COLORS[s])
  const fn = /^(rgba?|hsla?|hsva?)\(\s*([^)]*)\)$/.exec(s)
  if (fn) return parseFunc(fn[1].slice(0, 3), fn[2])
  if (/^#?[0-9a-f]+$/.test(s)) return parseHex(s)
  return { ok: false, error: ERR_UNKNOWN }
}

/** 解析 HEX（3/4/6/8 位） */
function parseHex(s: string): ParseResult {
  let h = s.replace(/^#/, '')
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
  if (h.length !== 6 && h.length !== 8) return { ok: false, error: 'HEX 需要 3、4、6 或 8 位' }
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
  return { ok: true, color: { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? round(n(6) / MAX_CHANNEL, 3) : 1 } }
}

/** 解析一个数值，percentBase 不为空时百分号按该基数换算；非法返回 NaN */
function num(token: string, percentBase?: number): number {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(%|deg)?$/.exec(token)
  if (!m) return NaN
  const v = parseFloat(m[1])
  return m[2] === '%' && percentBase !== undefined ? (v / 100) * percentBase : v
}

/** 解析函数写法 */
function parseFunc(kind: string, body: string): ParseResult {
  const parts = body.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return { ok: false, error: '参数个数不对，需要 3 个（可加透明度）' }
  const alpha = parts.length === 4 ? clamp(num(parts[3], 1), 0, 1) : 1
  if (Number.isNaN(alpha)) return { ok: false, error: '透明度不是数字' }
  if (kind === 'rgb') {
    const [r, g, b] = parts.slice(0, 3).map((p) => num(p, MAX_CHANNEL))
    if ([r, g, b].some(Number.isNaN)) return { ok: false, error: 'RGB 的值必须是数字' }
    return { ok: true, color: { r: clamp(r, 0, MAX_CHANNEL), g: clamp(g, 0, MAX_CHANNEL), b: clamp(b, 0, MAX_CHANNEL), a: alpha } }
  }
  // hsl / hsv：色相 + 两个百分数（可省略 %）
  const h = num(parts[0])
  const x = num(parts[1], 100)
  const y = num(parts[2], 100)
  if ([h, x, y].some(Number.isNaN)) return { ok: false, error: '色相和百分比必须是数字' }
  const hue = ((h % 360) + 360) % 360
  const rgb = kind === 'hsl' ? hslToRgb({ h: hue, s: clamp(x, 0, 100), l: clamp(y, 0, 100) }) : hsvToRgb({ h: hue, s: clamp(x, 0, 100), v: clamp(y, 0, 100) })
  return { ok: true, color: { ...rgb, a: alpha } }
}

/**
 * RGB 转 HSL。
 *
 * @param c 颜色（只用 r/g/b）
 * @returns HSL，未取整
 * @example
 * rgbToHsl({ r: 255, g: 0, b: 0, a: 1 }) // { h: 0, s: 100, l: 50 }
 */
export function rgbToHsl(c: Pick<Rgba, 'r' | 'g' | 'b'>): Hsl {
  const r = c.r / MAX_CHANNEL
  const g = c.g / MAX_CHANNEL
  const b = c.b / MAX_CHANNEL
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return { h: hueOf(r, g, b, max, d), s: s * 100, l: l * 100 }
}

/**
 * RGB 转 HSV。
 *
 * @param c 颜色（只用 r/g/b）
 * @returns HSV，未取整
 * @example
 * rgbToHsv({ r: 0, g: 255, b: 0, a: 1 }) // { h: 120, s: 100, v: 100 }
 */
export function rgbToHsv(c: Pick<Rgba, 'r' | 'g' | 'b'>): Hsv {
  const r = c.r / MAX_CHANNEL
  const g = c.g / MAX_CHANNEL
  const b = c.b / MAX_CHANNEL
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  return { h: hueOf(r, g, b, max, d), s: max === 0 ? 0 : (d / max) * 100, v: max * 100 }
}

/** 计算色相（0~360），无彩色时为 0 */
function hueOf(r: number, g: number, b: number, max: number, d: number): number {
  if (d === 0) return 0
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return (h * 60 + 360) % 360
}

/**
 * HSL 转 RGB。
 *
 * @param c HSL（h 0~360，s/l 0~100）
 * @returns r/g/b（0~255，未取整）
 * @example
 * hslToRgb({ h: 120, s: 100, l: 50 }) // { r: 0, g: 255, b: 0 }
 */
export function hslToRgb(c: Hsl): Pick<Rgba, 'r' | 'g' | 'b'> {
  const s = c.s / 100
  const l = c.l / 100
  const k = (n: number) => (n + c.h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * MAX_CHANNEL
  return { r: f(0), g: f(8), b: f(4) }
}

/**
 * HSV 转 RGB。
 *
 * @param c HSV（h 0~360，s/v 0~100）
 * @returns r/g/b（0~255，未取整）
 * @example
 * hsvToRgb({ h: 0, s: 100, v: 100 }) // { r: 255, g: 0, b: 0 }
 */
export function hsvToRgb(c: Hsv): Pick<Rgba, 'r' | 'g' | 'b'> {
  const s = c.s / 100
  const v = c.v / 100
  const k = (n: number) => (n + c.h / 60) % 6
  const f = (n: number) => (v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1))) * MAX_CHANNEL
  return { r: f(5), g: f(3), b: f(1) }
}

/** 两位十六进制 */
function hex2(v: number): string {
  return Math.round(clamp(v, 0, MAX_CHANNEL)).toString(16).padStart(2, '0')
}

/** 带透明度时的通用后缀 */
function alphaPart(a: number, sep: string): string {
  return a < 1 ? `${sep}${round(a, 2)}` : ''
}

/** 各格式的字符串输出 */
export interface Formats {
  /** `#rrggbb`，有透明度时为 `#rrggbbaa` */
  hex: string
  /** `rgb(r, g, b)` 或 `rgba(r, g, b, a)` */
  rgb: string
  /** `hsl(h, s%, l%)` 或 `hsla(...)` */
  hsl: string
  /** `hsv(h, s%, v%)`（非 CSS 标准写法，设计工具里常见） */
  hsv: string
}

/**
 * 把颜色格式化成各种写法。
 *
 * @param c 颜色
 * @returns 各格式字符串，大写 HEX
 * @example
 * formatColor({ r: 59, g: 108, b: 246, a: 1 }).hex // '#3B6CF6'
 */
export function formatColor(c: Rgba): Formats {
  const hsl = rgbToHsl(c)
  const hsv = rgbToHsv(c)
  const [r, g, b] = [c.r, c.g, c.b].map(Math.round)
  const alphaHex = c.a < 1 ? hex2(c.a * MAX_CHANNEL) : ''
  return {
    hex: `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${alphaHex}`.toUpperCase(),
    rgb: `${c.a < 1 ? 'rgba' : 'rgb'}(${r}, ${g}, ${b}${alphaPart(c.a, ', ')})`,
    hsl: `${c.a < 1 ? 'hsla' : 'hsl'}(${Math.round(hsl.h)}, ${Math.round(hsl.s)}%, ${Math.round(hsl.l)}%${alphaPart(c.a, ', ')})`,
    hsv: `hsv(${Math.round(hsv.h)}, ${Math.round(hsv.s)}%, ${Math.round(hsv.v)}%)`,
  }
}

/**
 * 按亮度挑选叠在该颜色上的文字色（黑或白），预览用。
 *
 * @param c 背景色
 * @returns '#000000' 或 '#ffffff'
 * @example
 * readableOn({ r: 255, g: 255, b: 255, a: 1 }) // '#000000'
 */
export function readableOn(c: Rgba): string {
  const y = (c.r * 299 + c.g * 587 + c.b * 114) / 1000
  return y >= 150 ? '#000000' : '#ffffff'
}
