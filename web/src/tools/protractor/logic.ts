// 量角器：屏上两条射线的夹角计算 + 倾角模式（复用水平仪算法），与 Vue 解耦
import { inPlaneAngle, totalTilt, type Vec3 } from '../level/logic'

/** 整圆度数 */
export const FULL_CIRCLE = 360
/** 半圆度数 */
export const HALF_CIRCLE = 180
/** 直角度数 */
export const RIGHT_ANGLE = 90
/** 吸附步长（度） */
export const SNAP_STEP = 5

/** 量角器盘面：半圆只用上半，全圆用整个圆 */
export type DialMode = 'half' | 'full'

/** 二维点 */
export interface Point {
  /** 横坐标 */
  x: number
  /** 纵坐标（屏幕向下为正） */
  y: number
}

/**
 * 角度归一到 [0, 360)。
 *
 * @param deg 任意角度
 * @returns 等价的 0~360（不含 360）角度
 * @example
 * normalize(-90) // 270
 */
export function normalize(deg: number): number {
  const r = ((deg % FULL_CIRCLE) + FULL_CIRCLE) % FULL_CIRCLE
  return r === 0 ? 0 : r
}

/**
 * 屏幕点相对圆心的方向角：向右为 0，逆时针为正（数学习惯，已翻转屏幕 y 轴）。
 *
 * @param center 圆心
 * @param p 目标点
 * @returns 0~360 度；点与圆心重合返回 null
 * @example
 * pointAngle({ x: 0, y: 0 }, { x: 0, y: -10 }) // 90（屏幕上方）
 */
export function pointAngle(center: Point, p: Point): number | null {
  const dx = p.x - center.x
  const dy = center.y - p.y
  if (Math.hypot(dx, dy) < 1e-9) return null
  return normalize((Math.atan2(dy, dx) * 180) / Math.PI)
}

/**
 * 极坐标转屏幕坐标（与 pointAngle 互逆）。
 *
 * @param center 圆心
 * @param r 半径
 * @param deg 方向角
 * @returns 屏幕上的点
 * @example
 * polar({ x: 0, y: 0 }, 10, 90) // { x: 0, y: -10 }
 */
export function polar(center: Point, r: number, deg: number): Point {
  const a = (deg * Math.PI) / 180
  return { x: center.x + r * Math.cos(a), y: center.y - r * Math.sin(a) }
}

/**
 * 从射线 from 逆时针转到射线 to 的角度。
 *
 * @param from 起始方向角
 * @param to 终止方向角
 * @returns 0~360（不含 360）
 * @example
 * sweepAngle(350, 10) // 20
 */
export function sweepAngle(from: number, to: number): number {
  return normalize(to - from)
}

/**
 * 两射线的夹角（取小的那一侧）。
 *
 * @param a 射线 A 方向角
 * @param b 射线 B 方向角
 * @returns 0~180 度
 * @example
 * includedAngle(350, 10) // 20
 */
export function includedAngle(a: number, b: number): number {
  const s = sweepAngle(a, b)
  return s > HALF_CIRCLE ? FULL_CIRCLE - s : s
}

/**
 * 按盘面限制射线角度：半圆只能落在 [0, 180]，全圆只归一。
 *
 * @param deg 方向角
 * @param mode 盘面模式
 * @returns 限制后的角度；半圆时下半区夹到距离较近的一端（270 以内到 180，之后到 0）
 * @example
 * clampAngle(200, 'half') // 180
 */
export function clampAngle(deg: number, mode: DialMode): number {
  const n = normalize(deg)
  if (mode === 'full' || n <= HALF_CIRCLE) return n
  return n < FULL_CIRCLE - (n - HALF_CIRCLE) ? HALF_CIRCLE : 0
}

/**
 * 角度吸附到步长整数倍。
 *
 * @param deg 方向角
 * @param step 步长，非正数时不吸附
 * @returns 吸附后的 0~360 角度
 * @example
 * snapAngle(47, 5) // 45
 */
export function snapAngle(deg: number, step: number): number {
  if (!(step > 0)) return normalize(deg)
  return normalize(Math.round(deg / step) * step)
}

/**
 * 找离指针方向最近的射线。
 *
 * @param rays 各射线方向角
 * @param pointerDeg 指针方向角
 * @returns 最近射线的下标；列表为空返回 -1
 * @example
 * nearestRay([0, 90], 80) // 1
 */
export function nearestRay(rays: number[], pointerDeg: number): number {
  let best = -1
  let bestD = Infinity
  rays.forEach((r, i) => {
    const d = includedAngle(r, pointerDeg)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

/**
 * 浏览器坐标换算成 SVG 视图坐标（SVG 等比缩放铺满盒子时）。
 *
 * @param client 指针的 clientX/clientY
 * @param rect SVG 元素的 getBoundingClientRect 结果
 * @param viewW viewBox 宽
 * @param viewH viewBox 高
 * @returns 视图内坐标；盒子尺寸为 0 时返回 null
 * @example
 * clientToView({ x: 50, y: 25 }, { left: 0, top: 0, width: 100, height: 50 }, 300, 150) // { x: 150, y: 75 }
 */
export function clientToView(client: Point, rect: { left: number; top: number; width: number; height: number }, viewW: number, viewH: number): Point | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  return { x: ((client.x - rect.left) / rect.width) * viewW, y: ((client.y - rect.top) / rect.height) * viewH }
}

/**
 * 倾角模式「贴边」：手机立着、长边贴着物体时，长边相对水平线的倾角。
 *
 * @param v 重力读数
 * @returns 0（长边水平）~90（长边竖直）度
 * @example
 * edgeInclination({ x: 0, y: 9.8, z: 0 }) // 90
 */
export function edgeInclination(v: Vec3): number {
  let a = Math.abs(inPlaneAngle(v))
  if (a > RIGHT_ANGLE) a = HALF_CIRCLE - a
  return RIGHT_ANGLE - a
}

/**
 * 倾角模式「贴面」：手机屏幕贴在斜面上时，斜面与水平面的夹角。直接复用水平仪的总倾斜角。
 *
 * @param v 重力读数
 * @returns 0~90 度
 * @example
 * surfaceInclination({ x: 0, y: 0, z: 9.8 }) // 0
 */
export function surfaceInclination(v: Vec3): number {
  return totalTilt(v)
}

/** 持久缓存命名空间 */
export const STORE_NS = 'protractor'
/** 可选盘面值 */
export const DIAL_VALUES: readonly DialMode[] = ['half', 'full']
/** 可选倾角测量方式值 */
export const TILT_KIND_VALUES = ['edge', 'surface'] as const
