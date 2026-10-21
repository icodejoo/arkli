// 持久缓存的校验函数：给 usePersistedRef 的 validate 用，缓存值不合法时回落默认值。
import type { CellOption } from './cellPicker'

/** 闭区间 */
export interface NumRange {
  /** 下限 */
  min: number
  /** 上限 */
  max: number
}

/**
 * 是否为落在闭区间内的有限数字（校验滑块、步进器的缓存值）。
 * @param v 待检查的值
 * @param range 闭区间
 * @returns 合法返回 true
 * @example inRange(5, { min: 0, max: 10 }) // true
 */
export function inRange(v: unknown, range: NumRange): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= range.min && v <= range.max
}

/**
 * 是否为 `#rrggbb` 颜色（校验颜色选择的缓存值）。
 * @param v 待检查的值
 * @returns 合法返回 true
 * @example isHexColor('#ff0000') // true
 */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

/**
 * 生成“值必须在选项里”的校验函数（校验 CellPicker、分段选择的缓存值）。
 * @param options 选项列表（CellOption 数组，或普通值数组）
 * @returns 校验函数
 * @example oneOf([{ value: 'a', label: 'A' }])('a') // true
 */
export function oneOf<T = string | number>(options: readonly (CellOption | string | number)[]): (v: T) => boolean {
  return (v) => options.some((o) => (typeof o === 'object' ? o.value : o) === v)
}

/**
 * 是否为布尔值（校验开关的缓存值）。
 * @param v 待检查的值
 * @returns 是布尔返回 true
 */
export function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean'
}
