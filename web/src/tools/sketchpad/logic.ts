// 画板纯逻辑：笔画栈（撤销/重做）、画布尺寸换算、点抽稀。不依赖 DOM，便于单测。

/** 一个点：CSS 像素坐标 */
export interface Pt {
  /** 横坐标 */
  x: number
  /** 纵坐标 */
  y: number
}

/** 一条笔画 */
export interface Stroke {
  /** 路径点（CSS 像素坐标，与画布缩放无关） */
  points: Pt[]
  /** 颜色，如 #ff0000（橡皮时忽略） */
  color: string
  /** 线宽（CSS 像素） */
  width: number
  /** 是否橡皮 */
  erase: boolean
}

/** 笔画栈：已画的笔画 + 被撤销、可重做的笔画 */
export interface StrokeStack {
  /** 已生效的笔画（先画在前） */
  strokes: Stroke[]
  /** 被撤销的笔画，栈顶（末尾）是最近撤销的 */
  redo: Stroke[]
}

/** 屏幕画布的像素比上限 */
export const MAX_DPR = 2
/** 导出图最长边上限（像素），防止大屏爆内存 */
export const MAX_EXPORT_EDGE = 4096
/** 最小线宽 */
export const MIN_WIDTH = 1
/** 最大线宽 */
export const MAX_WIDTH = 60
/** 相邻采样点最小间距（CSS 像素），小于它的点丢掉 */
export const MIN_POINT_GAP = 0.8
/** 单条笔画最多保留的点数，防止无限增长 */
export const MAX_POINTS = 5000
/** 默认画笔颜色 */
export const DEFAULT_COLOR = '#222222'
/** 默认背景色 */
export const DEFAULT_BG = '#ffffff'
/** 颜色匹配：#rgb 或 #rrggbb */
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * 新建空笔画栈。
 *
 * @returns 空栈
 * @example createStack() // { strokes: [], redo: [] }
 */
export function createStack(): StrokeStack {
  return { strokes: [], redo: [] }
}

/**
 * 追加一条笔画；新笔画会清空重做栈。返回新栈，不改原对象。
 *
 * @param s 当前栈
 * @param stroke 新笔画
 * @returns 新栈
 * @example addStroke(createStack(), stroke).strokes.length // 1
 */
export function addStroke(s: StrokeStack, stroke: Stroke): StrokeStack {
  return { strokes: [...s.strokes, stroke], redo: [] }
}

/**
 * 撤销最后一笔。没有可撤销的笔画时原样返回。
 *
 * @param s 当前栈
 * @returns 新栈
 */
export function undo(s: StrokeStack): StrokeStack {
  if (!s.strokes.length) return s
  const last = s.strokes[s.strokes.length - 1]
  return { strokes: s.strokes.slice(0, -1), redo: [...s.redo, last] }
}

/**
 * 重做最近一次撤销的笔画。没有可重做的笔画时原样返回。
 *
 * @param s 当前栈
 * @returns 新栈
 */
export function redo(s: StrokeStack): StrokeStack {
  if (!s.redo.length) return s
  const last = s.redo[s.redo.length - 1]
  return { strokes: [...s.strokes, last], redo: s.redo.slice(0, -1) }
}

/**
 * 清空画布。清空本身不可撤销，重做栈也一并清掉。
 *
 * @returns 空栈
 */
export function clearStack(): StrokeStack {
  return createStack()
}

/**
 * 能否撤销。
 *
 * @param s 当前栈
 * @returns 是否有可撤销的笔画
 */
export function canUndo(s: StrokeStack): boolean {
  return s.strokes.length > 0
}

/**
 * 能否重做。
 *
 * @param s 当前栈
 * @returns 是否有可重做的笔画
 */
export function canRedo(s: StrokeStack): boolean {
  return s.redo.length > 0
}

/**
 * 限制线宽到合法范围；非数字回落到最小线宽。
 *
 * @param w 输入线宽
 * @returns 取整后的线宽
 * @example clampWidth(100) // 60
 */
export function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return MIN_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)))
}

/**
 * 判断是不是合法的 #rgb / #rrggbb 颜色。
 *
 * @param c 颜色串
 * @returns 是否合法
 * @example isHexColor('#fff') // true
 */
export function isHexColor(c: string): boolean {
  return HEX_RE.test(c)
}

/**
 * 往笔画里追加一个点：与上一点太近就丢弃，超过点数上限也丢弃。
 *
 * @param points 现有点（会被原地追加）
 * @param p 新点
 * @returns 是否真的加进去了
 * @example const ps = [{ x: 0, y: 0 }]; appendPoint(ps, { x: 5, y: 0 }) // true
 */
export function appendPoint(points: Pt[], p: Pt): boolean {
  if (points.length >= MAX_POINTS) return false
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false
  const last = points[points.length - 1]
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_POINT_GAP) return false
  points.push(p)
  return true
}

/**
 * 计算画布像素缩放：取设备像素比（封顶 MAX_DPR），并保证最长边不超过导出上限。
 *
 * @param cssW 画布 CSS 宽
 * @param cssH 画布 CSS 高
 * @param dpr 设备像素比，非法值按 1
 * @returns 缩放系数（大于 0）
 * @example canvasScale(400, 800, 3) // 2
 */
export function canvasScale(cssW: number, cssH: number, dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  let s = Math.min(d, MAX_DPR)
  const edge = Math.max(cssW, cssH)
  if (edge > 0 && edge * s > MAX_EXPORT_EDGE) s = MAX_EXPORT_EDGE / edge
  return s
}

/**
 * 按缩放系数算像素尺寸，至少 1x1。
 *
 * @param cssW CSS 宽
 * @param cssH CSS 高
 * @param scale 缩放系数
 * @returns 像素宽高
 * @example pixelSize(100, 50, 2) // { width: 200, height: 100 }
 */
export function pixelSize(cssW: number, cssH: number, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(cssW * scale)), height: Math.max(1, Math.round(cssH * scale)) }
}

/**
 * 生成导出文件名，如 sketch-20260102-030405.png。
 *
 * @param d 时间
 * @returns 文件名
 * @example exportName(new Date(2026, 0, 2, 3, 4, 5)) // 'sketch-20260102-030405.png'
 */
export function exportName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `sketch-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`
}
