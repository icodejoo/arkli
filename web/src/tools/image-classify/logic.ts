import type { ClassifyItem } from '@/native/ai'

/** 可选的结果条数 */
export const TOP_K_OPTIONS = [3, 5, 10]
/** 默认条数 */
export const DEFAULT_TOP_K = 5
/** 条形最小宽度百分比，分数极低时也能看见 */
const MIN_BAR_PERCENT = 2

/** 展示用的一行 */
export interface ClassifyRow {
  /** 标签 */
  label: string
  /** 百分比文案，如 `87.3%` */
  percent: string
  /** 条形宽度（0~100，相对第一名） */
  bar: number
}

/**
 * 整理原生返回的分类结果：丢弃非法项、按分数降序、截取前 K 条。
 *
 * @param items 原生返回的条目
 * @param topK 保留条数
 * @returns 整理后的条目
 * @example normalizeItems([{ label: 'a', score: 0.2 }, { label: 'b', score: 0.8 }], 1) // [{ label: 'b', score: 0.8 }]
 */
export function normalizeItems(items: ClassifyItem[], topK: number): ClassifyItem[] {
  return items
    .filter((i) => i && typeof i.label === 'string' && i.label !== '' && isFinite(i.score))
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topK))
}

/**
 * 分数转百分比文案。
 *
 * @param score 0~1 的分数，越界会夹紧
 * @returns 如 `87.3%`
 * @example percentText(0.873) // '87.3%'
 */
export function percentText(score: number): string {
  const s = Math.min(1, Math.max(0, score))
  return `${(s * 100).toFixed(1)}%`
}

/**
 * 生成展示行：条形宽度相对第一名，便于看出差距。
 *
 * @param items 已排好序的条目
 * @returns 展示行
 * @example toRows([{ label: 'a', score: 0.8 }, { label: 'b', score: 0.4 }]).map((r) => r.bar) // [100, 50]
 */
export function toRows(items: ClassifyItem[]): ClassifyRow[] {
  const top = items.length ? Math.max(items[0].score, 0) : 0
  return items.map((i) => ({
    label: i.label,
    percent: percentText(i.score),
    bar: top > 0 ? Math.max(MIN_BAR_PERCENT, Math.min(100, Math.round((Math.max(i.score, 0) / top) * 100))) : MIN_BAR_PERCENT,
  }))
}
