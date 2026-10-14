// 指尖轮盘：多指按住，稳定一段时间后随机选一个 / 排先手 / 分两队

import { cryptoSource, pick, shuffle, type RandomSource } from '@/shared/random'

/** 模式：选一个 / 选先手（全员排序）/ 分两队 */
export type Mode = 'one' | 'first' | 'teams'

/** 一个手指的角色 */
export type Role = 'winner' | 'loser' | 'teamA' | 'teamB' | 'ranked'

/** 触点稳定多久后出结果（毫秒） */
export const COUNTDOWN_MS = 3000
/** 手指位移超过多少像素算“动了”，要重新计时 */
export const MOVE_TOLERANCE_PX = 12
/** 最少手指数 */
export const MIN_FINGERS = 2
/** 最多处理的手指数，超出的忽略（安卓一般最多 10 点） */
export const MAX_FINGERS = 10
/** 模式的中文名 */
export const MODE_LABEL: Record<Mode, string> = { one: '选一个', first: '选先手', teams: '分两队' }
/** 指圈色板（内容色，不随主题变） */
export const FINGER_COLORS = ['#3b6cf6', '#ee0a24', '#07c160', '#ff976a', '#7232dd', '#1989fa', '#f2b600', '#e84393', '#13c2c2', '#8c8c8c'] as const

/** 二维坐标 */
export interface Point {
  x: number
  y: number
}

/** 一个手指的分配结果 */
export interface Assignment {
  /** 触点 id（pointerId） */
  id: number
  /** 角色 */
  role: Role
  /** 先手模式下的顺位（1 起），其他模式为 0 */
  order: number
}

/**
 * 手指有没有明显移动（欧氏距离大于容差）。
 *
 * @param a 起点
 * @param b 当前点
 * @param tol 容差像素，默认 MOVE_TOLERANCE_PX
 * @returns 超过容差为 true，刚好等于容差不算
 * @example
 * hasMoved({ x: 0, y: 0 }, { x: 20, y: 0 }) // true
 */
export function hasMoved(a: Point, b: Point, tol: number = MOVE_TOLERANCE_PX): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) > tol
}

/**
 * 当前手指数能不能开始倒计时。
 *
 * @param count 手指数
 * @returns 达到 MIN_FINGERS 为 true
 * @example
 * canCountdown(1) // false
 */
export function canCountdown(count: number): boolean {
  return count >= MIN_FINGERS
}

/**
 * 倒计时进度。
 *
 * @param elapsedMs 已过去的毫秒数
 * @returns 0~1，越界会被截断；负数或 NaN 当作 0
 * @example
 * countdownProgress(1500) // 0.5
 */
export function countdownProgress(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  return Math.min(1, elapsedMs / COUNTDOWN_MS)
}

/**
 * 按模式给每个手指分配角色，先定结果再播表现。
 *
 * - one：随机一个 winner，其余 loser
 * - first：全员随机排序，order 为顺位，第 1 位 role 为 winner，其余 ranked
 * - teams：随机打乱后前半（多出的一人归 A）为 teamA，后半为 teamB
 *
 * @param ids 触点 id 列表（至少 2 个，不重复）
 * @param mode 模式
 * @param src 随机源
 * @returns 与 ids 同顺序的分配结果
 * @throws RangeError 手指数不足
 * @example
 * assignRoles([1, 2, 3], 'one')
 */
export function assignRoles(ids: readonly number[], mode: Mode, src: RandomSource = cryptoSource): Assignment[] {
  if (ids.length < MIN_FINGERS) throw new RangeError('assignRoles: 手指数不足')
  if (mode === 'one') {
    const w = pick(ids, src)
    return ids.map((id) => ({ id, role: id === w ? 'winner' : 'loser', order: 0 }))
  }
  const shuffled = shuffle(ids, src)
  if (mode === 'first') {
    return ids.map((id) => {
      const order = shuffled.indexOf(id) + 1
      return { id, role: order === 1 ? 'winner' : 'ranked', order }
    })
  }
  const aSize = Math.ceil(shuffled.length / 2)
  const teamA = new Set(shuffled.slice(0, aSize))
  return ids.map((id) => ({ id, role: teamA.has(id) ? 'teamA' : 'teamB', order: 0 }))
}

/**
 * 按触点出现顺序取指圈颜色。
 *
 * @param index 第几个触点（从 0 起），超出色板循环
 * @returns 颜色
 * @example
 * colorFor(0) // '#3b6cf6'
 */
export function colorFor(index: number): string {
  const n = FINGER_COLORS.length
  return FINGER_COLORS[((Math.floor(index) % n) + n) % n]
}
