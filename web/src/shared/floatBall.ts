/** 浮窗圆球的尺寸、吸边、投放判定等纯函数与常量（组件见 FloatBall.vue）。 */

/** 圆球直径（px） */
export const BALL_SIZE = 48
/** 圆球吸边后离屏幕边缘的距离 */
export const EDGE_MARGIN = 8
/** 圆球纵向最小位置（避开状态栏与标题栏） */
export const Y_MIN = 56
/** 圆球底部预留（避开底栏与手势条） */
export const Y_BOTTOM_RESERVE = 72
/** 拖动判定阈值：移动超过它才算拖动，否则算点击 */
export const DRAG_THRESHOLD = 6
/** 投放区直径 */
export const DROP_SIZE = 72
/** 投放区底边离屏幕底部的距离 */
export const DROP_BOTTOM = 56
/** 圆球中心进入投放区中心多远算命中（比视觉半径宽松，好投） */
export const DROP_HIT_RADIUS = 64
/** 圆球层级：高于底栏与操作栏（≤ 2），低于 Vant 弹层（2000+） */
export const FLOAT_Z = 100
/** 圆球位置存储键 */
export const FLOAT_POS_KEY = 'arkli.float.pos'
/** 默认纵向位置占屏高比例 */
export const DEFAULT_Y_RATIO = 0.6

/** 吸附的边 */
export type FloatSide = 'left' | 'right'

/** 圆球停靠位置：吸在哪边与纵向坐标 */
export interface FloatPos {
  /** 左或右边缘 */
  side: FloatSide
  /** 圆球顶边的纵坐标（px） */
  y: number
}

/**
 * 把圆球纵坐标夹在可见范围内。
 *
 * @param y 期望的纵坐标
 * @param vh 视口高度
 * @returns 夹紧后的纵坐标
 * @example
 * clampY(-20, 800) // 56
 */
export function clampY(y: number, vh: number): number {
  const max = Math.max(Y_MIN, vh - BALL_SIZE - Y_BOTTOM_RESERVE)
  return Math.min(Math.max(y, Y_MIN), max)
}

/**
 * 把圆球横坐标夹在屏幕内（拖动过程用）。
 *
 * @param x 期望的左边缘横坐标
 * @param vw 视口宽度
 * @returns 夹紧后的横坐标
 */
export function clampX(x: number, vw: number): number {
  return Math.min(Math.max(x, 0), Math.max(0, vw - BALL_SIZE))
}

/**
 * 松手后吸到哪一边：圆球中心在屏幕左半就吸左，否则吸右。
 *
 * @param x 圆球左边缘横坐标
 * @param vw 视口宽度
 * @returns 吸附的边
 * @example
 * snapSide(300, 360) // 'right'
 */
export function snapSide(x: number, vw: number): FloatSide {
  return x + BALL_SIZE / 2 < vw / 2 ? 'left' : 'right'
}

/**
 * 某一边对应的圆球左边缘横坐标。
 *
 * @param side 吸附的边
 * @param vw 视口宽度
 * @returns 横坐标
 */
export function sideX(side: FloatSide, vw: number): number {
  return side === 'left' ? EDGE_MARGIN : vw - BALL_SIZE - EDGE_MARGIN
}

/**
 * 投放区中心坐标（屏幕底部中间）。
 *
 * @param vw 视口宽度
 * @param vh 视口高度
 * @returns 中心点
 */
export function dropCenter(vw: number, vh: number): { x: number; y: number } {
  return { x: vw / 2, y: vh - DROP_BOTTOM - DROP_SIZE / 2 }
}

/**
 * 圆球是否落在投放区内（按圆球中心到投放区中心的距离判断）。
 *
 * @param x 圆球左边缘横坐标
 * @param y 圆球顶边纵坐标
 * @param vw 视口宽度
 * @param vh 视口高度
 * @returns 命中返回 true
 * @example
 * inDropZone(156, 700, 360, 800) // true
 */
export function inDropZone(x: number, y: number, vw: number, vh: number): boolean {
  const c = dropCenter(vw, vh)
  return Math.hypot(x + BALL_SIZE / 2 - c.x, y + BALL_SIZE / 2 - c.y) <= DROP_HIT_RADIUS
}

/**
 * 位移是否已超过拖动阈值。
 *
 * @param dx 横向位移
 * @param dy 纵向位移
 * @returns 超过返回 true
 */
export function exceedsDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > DRAG_THRESHOLD
}

/**
 * 解析存储的位置；格式不对返回 null。
 *
 * @param raw localStorage 里的原文
 * @returns 位置或 null
 */
export function parsePos(raw: string | null): FloatPos | null {
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as Partial<FloatPos>
    if ((d.side === 'left' || d.side === 'right') && typeof d.y === 'number' && Number.isFinite(d.y)) return { side: d.side, y: d.y }
  } catch {
    // 损坏的数据当没有
  }
  return null
}

/**
 * 圆球的无障碍标签。
 *
 * @param name 工具名
 * @returns 文案
 * @example
 * floatBallLabel('番茄钟') // '浮窗：番茄钟，点击返回'
 */
export function floatBallLabel(name: string): string {
  return `浮窗：${name}，点击返回`
}
