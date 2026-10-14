/**
 * 纯色图与渐变图的纯逻辑：尺寸预设与校验、色标整理与插值、线性/径向渐变几何、CSS 渐变串。
 * 不碰 DOM，可直接单测。
 */
import { exceedsCanvas, MAX_CANVAS_SIDE } from '@/shared/image-calc'

/** 色标数量下限 */
export const STOP_MIN = 2
/** 色标数量上限 */
export const STOP_MAX = 5
/** 单边最小像素 */
export const SIZE_MIN = 1

/** 尺寸预设 */
export interface SizePreset {
  /** 展示名 */
  label: string
  /** 宽 */
  width: number
  /** 高 */
  height: number
}

/** 常见尺寸预设（手机屏的“本机”由页面按 screen 实时生成） */
export const SIZE_PRESETS: SizePreset[] = [
  { label: '1080×1920 手机', width: 1080, height: 1920 },
  { label: '1440×3200 手机', width: 1440, height: 3200 },
  { label: '1920×1080 1080p', width: 1920, height: 1080 },
  { label: '3840×2160 4K', width: 3840, height: 2160 },
  { label: '1080×1080 方图', width: 1080, height: 1080 },
  { label: '1242×2688 iPhone', width: 1242, height: 2688 },
]

/** 渐变色标 */
export interface ColorStop {
  /** `#RRGGBB` 颜色 */
  color: string
  /** 位置 0~100（百分比） */
  pos: number
}

/** 渐变类型 */
export type GradientKind = 'linear' | 'radial'

/** 尺寸校验结果 */
export interface SizeCheck {
  /** 是否可用 */
  ok: boolean
  /** 不可用时的原因 */
  message: string
  /** 规整后的宽（取整） */
  width: number
  /** 规整后的高（取整） */
  height: number
}

/**
 * 校验输出尺寸：必须是正整数，且不超过 Canvas 安全上限。
 *
 * @param width 宽
 * @param height 高
 * @returns 校验结果，ok 为 false 时 message 给出原因
 * @example checkSize(1080, 1920) // { ok: true, message: '', width: 1080, height: 1920 }
 */
export function checkSize(width: number, height: number): SizeCheck {
  const w = Math.round(width)
  const h = Math.round(height)
  const fail = (message: string): SizeCheck => ({ ok: false, message, width: w, height: h })
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < SIZE_MIN || h < SIZE_MIN) return fail('宽高要大于 0')
  if (exceedsCanvas(w, h)) return fail(`尺寸过大，单边不超过 ${MAX_CANVAS_SIDE}，总像素不超过 6400 万`)
  return { ok: true, message: '', width: w, height: h }
}

/**
 * 解析 `#RGB` / `#RRGGBB` 为通道值。
 *
 * @param hex 十六进制色值
 * @returns [r, g, b]；格式不对返回 null
 * @example parseHex('#f80') // [255, 136, 0]
 */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const s = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}

/**
 * 通道值转 `#RRGGBB`（小写）。
 *
 * @param rgb [r, g, b]
 * @example rgbToHex([255, 0, 128]) // '#ff0080'
 */
export function rgbToHex(rgb: number[]): string {
  return `#${rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`
}

/**
 * 整理色标：位置夹到 0~100、按位置稳定排序、颜色非法的回退黑色。
 *
 * @param stops 原色标
 * @returns 新数组，不改入参
 * @example normalizeStops([{ color: '#fff', pos: 120 }, { color: '#000', pos: 0 }]) // 黑 0、白 100
 */
export function normalizeStops(stops: ColorStop[]): ColorStop[] {
  return stops
    .map((s, i) => ({
      i,
      color: parseHex(s.color) ? rgbToHex(parseHex(s.color)!) : '#000000',
      pos: Math.max(0, Math.min(100, Number.isFinite(s.pos) ? s.pos : 0)),
    }))
    .sort((a, b) => a.pos - b.pos || a.i - b.i)
    .map(({ color, pos }) => ({ color, pos }))
}

/**
 * 取渐变上 t 位置的颜色，在相邻色标间按 RGB 线性插值；t 在首尾色标之外取端点色。
 *
 * @param stops 色标（会先整理）
 * @param t 位置 0~100
 * @returns `#rrggbb`
 * @example colorAt([{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 100 }], 50) // '#808080'
 */
export function colorAt(stops: ColorStop[], t: number): string {
  const list = normalizeStops(stops)
  if (list.length === 0) return '#000000'
  if (t <= list[0].pos) return list[0].color
  const last = list[list.length - 1]
  if (t >= last.pos) return last.color
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]
    const b = list[i]
    if (t <= b.pos) {
      const k = b.pos === a.pos ? 1 : (t - a.pos) / (b.pos - a.pos)
      const ca = parseHex(a.color)!
      const cb = parseHex(b.color)!
      return rgbToHex(ca.map((v, j) => v + (cb[j] - v) * k))
    }
  }
  return last.color
}

/**
 * 线性渐变的起止点，约定同 CSS：0° 朝上，90° 朝右，渐变线穿过画布中心，
 * 长度取使四角恰好落在 0%/100% 的值，所以画布导出与 CSS 预览一致。
 *
 * @param width 画布宽
 * @param height 画布高
 * @param angle 角度（度）
 * @returns 起点 (x0,y0)、终点 (x1,y1)
 * @example linearLine(100, 100, 90) // x0=0,y0=50 → x1=100,y1=50
 */
export function linearLine(width: number, height: number, angle: number): { x0: number; y0: number; x1: number; y1: number } {
  const rad = (angle * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad)
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2
  const cx = width / 2
  const cy = height / 2
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half }
}

/**
 * 径向渐变（圆形、居中、延伸到最远角，同 CSS `circle farthest-corner`）的圆心与半径。
 *
 * @param width 画布宽
 * @param height 画布高
 * @returns 圆心与半径
 * @example radialCircle(600, 800) // { cx: 300, cy: 400, r: 500 }
 */
export function radialCircle(width: number, height: number): { cx: number; cy: number; r: number } {
  return { cx: width / 2, cy: height / 2, r: Math.hypot(width / 2, height / 2) }
}

/**
 * 生成 CSS 渐变字符串，用于页面预览。
 *
 * @param kind 渐变类型
 * @param stops 色标（会先整理）
 * @param angle 线性渐变角度
 * @returns 可直接用作 background 的值
 * @example gradientCss('linear', [{ color: '#f00', pos: 0 }, { color: '#00f', pos: 100 }], 90)
 */
export function gradientCss(kind: GradientKind, stops: ColorStop[], angle: number): string {
  const list = normalizeStops(stops).map((s) => `${s.color} ${s.pos}%`).join(', ')
  return kind === 'linear' ? `linear-gradient(${angle}deg, ${list})` : `radial-gradient(circle farthest-corner at 50% 50%, ${list})`
}

/**
 * 新增一个色标：放在最大空隙中间，颜色取该处渐变色；已达上限时原样返回。
 *
 * @param stops 当前色标
 * @returns 新数组（已整理）
 * @example addStop([{ color: '#000000', pos: 0 }, { color: '#ffffff', pos: 100 }]) // 中间多一个 #808080
 */
export function addStop(stops: ColorStop[]): ColorStop[] {
  const list = normalizeStops(stops)
  if (list.length >= STOP_MAX) return list
  let best = 0
  for (let i = 1; i + 1 < list.length; i++) {
    if (list[i + 1].pos - list[i].pos > list[best + 1].pos - list[best].pos) best = i
  }
  const a = list[best]
  const b = list[best + 1]
  const pos = Math.round((a.pos + b.pos) / 2)
  return normalizeStops([...list, { color: colorAt(list, pos), pos }])
}

/**
 * 删除第 index 个色标；已到下限时原样返回。
 *
 * @param stops 当前色标
 * @param index 要删的下标
 * @returns 新数组
 */
export function removeStop(stops: ColorStop[], index: number): ColorStop[] {
  if (stops.length <= STOP_MIN || index < 0 || index >= stops.length) return stops.slice()
  return stops.filter((_, i) => i !== index)
}
