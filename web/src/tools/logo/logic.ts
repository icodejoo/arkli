// logo 设计页的纯逻辑：默认参数、方案 → 参数、图标搜索、取值夹紧、导出文件名。交互细节抽在这里便于单测。

import { ICON_DATA, type IconGroup } from './assets/iconData'
import type { LogoPlan } from './plan'
import { FONT_SCALE_MAX, FONT_SCALE_MIN, SPACING_MAX, SPACING_MIN, type LogoParams } from './types'

/** 品牌名最大长度 */
export const NAME_MAX = 20
/** 标语最大长度 */
export const SLOGAN_MAX = 30
/** 一句话描述最大长度 */
export const DESC_MAX = 60
/** 图标搜索一次最多展示几个 */
export const ICON_SEARCH_LIMIT = 48
/** 导出文件名前缀 */
const FILE_PREFIX = 'logo'
/** 文件名里不允许的字符 */
const FILE_ILLEGAL = /[\/:*?"<>|\s]+/g
/** 文件名里品牌名最长保留几个字 */
const FILE_NAME_MAX = 12

/** 页面上的三项输入 */
export interface LogoInput {
  /** 品牌名 */
  name: string
  /** 标语 */
  slogan: string
  /** 一句话描述 */
  desc: string
}

/**
 * 能不能生成方案：品牌名去空白后非空。
 *
 * @param name 品牌名输入
 * @returns 是否可以生成
 * @example canGenerate('  ') // false
 */
export function canGenerate(name: string): boolean {
  return name.trim().length > 0
}

/**
 * 夹紧到闭区间；非数字回到 fallback。
 *
 * @param v 输入值
 * @param min 下限
 * @param max 上限
 * @param fallback 非数字时的值
 * @returns 夹紧后的数
 * @example clamp(9, 0, 1, 0.5) // 1
 */
export function clamp(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

/**
 * 方案 + 输入 → 完整参数（字号、字距取默认，不反色）。
 *
 * @param plan 一个方案
 * @param input 页面输入
 * @returns logo 参数
 * @example paramsFromPlan({ template: 'stack', palette: 'tech-blue', icon: 'coffee', font: 'sans-bold' }, { name: 'A', slogan: '', desc: '' })
 */
export function paramsFromPlan(plan: LogoPlan, input: LogoInput): LogoParams {
  return {
    template: plan.template,
    palette: plan.palette,
    icon: plan.icon,
    name: input.name.trim().slice(0, NAME_MAX),
    slogan: input.slogan.trim().slice(0, SLOGAN_MAX),
    font: plan.font,
    fontScale: 1,
    spacing: 0.04,
    invert: false,
  }
}

/**
 * 编辑时改品牌名/标语后，把输入同步到参数（不动版式与配色）。
 *
 * @param p 当前参数
 * @param input 页面输入
 * @returns 新参数
 * @example syncInput(params, { name: '新名', slogan: '', desc: '' })
 */
export function syncInput(p: LogoParams, input: LogoInput): LogoParams {
  return { ...p, name: input.name.trim().slice(0, NAME_MAX), slogan: input.slogan.trim().slice(0, SLOGAN_MAX) }
}

/**
 * 取夹紧后的字号倍率。
 *
 * @param v 滑杆值
 * @returns 范围内的倍率
 * @example clampFontScale(3) // 1.4
 */
export function clampFontScale(v: number): number {
  return clamp(v, FONT_SCALE_MIN, FONT_SCALE_MAX, 1)
}

/**
 * 取夹紧后的字距（em）。
 *
 * @param v 滑杆值
 * @returns 范围内的字距
 * @example clampSpacing(-1) // -0.05
 */
export function clampSpacing(v: number): number {
  return clamp(v, SPACING_MIN, SPACING_MAX, 0.04)
}

/**
 * 搜索图标：按图标名或中文关键词做包含匹配；空查询返回指定分组（不给分组则全部）。
 *
 * @param query 搜索词
 * @param group 限定分组，可空
 * @returns 图标名列表（最多 {@link ICON_SEARCH_LIMIT} 个）
 * @example searchIcons('咖啡') // ['coffee', ...]
 */
export function searchIcons(query: string, group?: IconGroup | ''): string[] {
  const q = query.trim().toLowerCase()
  const names = Object.keys(ICON_DATA).filter((k) => !group || ICON_DATA[k].g === group)
  if (!q) return names.slice(0, ICON_SEARCH_LIMIT)
  return names.filter((k) => k.includes(q) || ICON_DATA[k].k.some((w) => w.toLowerCase().includes(q) || q.includes(w.toLowerCase()))).slice(0, ICON_SEARCH_LIMIT)
}

/**
 * 导出文件名：`logo-品牌名.png`，非法字符去掉，过长截断。
 *
 * @param name 品牌名
 * @returns 文件名
 * @example outputName('山屿 咖啡') // 'logo-山屿咖啡.png'
 */
export function outputName(name: string): string {
  const safe = name.replace(FILE_ILLEGAL, '').slice(0, FILE_NAME_MAX)
  return safe ? `${FILE_PREFIX}-${safe}.png` : `${FILE_PREFIX}.png`
}
