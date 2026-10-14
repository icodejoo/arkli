// 文件夹清理：模式、阈值、排序、勾选与合计（纯逻辑）
import type { DirDeleteResult, DirItem, DirScanMode } from '@/native/dir'

/** 排序方式：大小（大的在前） / 修改时间（旧的在前） / 路径 */
export type SortKey = 'size' | 'time' | 'path'

/** 一字节对应的 MB */
const MB = 1024 * 1024
/** 单位进位基数 */
const UNIT_BASE = 1024
/** 字节单位 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const
/** 单次删除的条数上限，与原生一致 */
export const DELETE_BATCH = 500

/** 扫描模式选项（不含「全部」） */
export const MODE_OPTIONS: Array<{ key: Exclude<DirScanMode, 'all'>; name: string; hint: string }> = [
  { key: 'large', name: '大文件', hint: '找出体积超过阈值的文件' },
  { key: 'empty', name: '空文件', hint: '0 字节文件与不含任何文件的空文件夹' },
  { key: 'apk', name: '安装包', hint: '.apk / .apks / .xapk' },
]
/** 大文件阈值选项（MB） */
export const THRESHOLD_OPTIONS_MB = [10, 50, 100, 500, 1024] as const
/** 阈值缺省值（MB），与原生缺省一致 */
export const DEFAULT_THRESHOLD_MB = 50
/** 排序选项 */
export const SORT_OPTIONS: Array<{ key: SortKey; name: string }> = [
  { key: 'size', name: '按大小' },
  { key: 'time', name: '按时间' },
  { key: 'path', name: '按路径' },
]

/**
 * 字节数转人类可读文本。
 *
 * @param bytes 字节数
 * @returns 如 `1.5 MB`；负数与非数字按 0 处理
 * @example formatBytes(1536) // '1.5 KB'
 */
export function formatBytes(bytes: number): string {
  let v = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  let i = 0
  while (v >= UNIT_BASE && i < UNITS.length - 1) {
    v /= UNIT_BASE
    i++
  }
  const text = i === 0 || v >= 100 ? Math.round(v).toString() : v.toFixed(1)
  return `${text} ${UNITS[i]}`
}

/**
 * 阈值（MB）转字节。
 *
 * @param mb 兆字节
 * @returns 字节数
 */
export function thresholdBytes(mb: number): number {
  return Math.round(mb * MB)
}

/**
 * 阈值的显示文字。
 *
 * @param mb 兆字节
 * @returns 如 `100 MB`、`1 GB`
 */
export function thresholdLabel(mb: number): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`
}

/**
 * 排序，返回新数组。大小大的在前；时间旧的在前（未知时间排最后）；并列按路径。
 *
 * @param items 扫描结果
 * @param key 排序方式
 * @returns 排好序的新列表
 */
export function sortItems(items: DirItem[], key: SortKey): DirItem[] {
  const byPath = (a: DirItem, b: DirItem) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)
  const time = (x: DirItem) => (x.lastModifiedMs > 0 ? x.lastModifiedMs : Number.MAX_SAFE_INTEGER)
  return items.slice().sort((a, b) => {
    if (key === 'size') return b.bytes - a.bytes || byPath(a, b)
    if (key === 'time') return time(a) - time(b) || byPath(a, b)
    return byPath(a, b)
  })
}

/**
 * 切换一项的勾选，返回新集合。
 *
 * @param selected 已选 id
 * @param id 要切换的 id
 * @returns 新集合
 */
export function toggleSelect(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (!next.delete(id)) next.add(id)
  return next
}

/**
 * 全选或取消全选：已经全部选中就清空，否则选中全部。
 *
 * @param items 当前列表
 * @param selected 已选 id
 * @returns 新集合
 */
export function toggleAll(items: DirItem[], selected: ReadonlySet<string>): Set<string> {
  return allSelected(items, selected) ? new Set() : new Set(items.map((i) => i.id))
}

/**
 * 是否已全选（空列表不算）。
 *
 * @param items 当前列表
 * @param selected 已选 id
 * @returns 全选返回 true
 */
export function allSelected(items: DirItem[], selected: ReadonlySet<string>): boolean {
  return items.length > 0 && items.every((i) => selected.has(i.id))
}

/**
 * 已选项的合计。
 *
 * @param items 当前列表
 * @param selected 已选 id
 * @returns 条数与可释放字节数
 */
export function selectedTotals(items: DirItem[], selected: ReadonlySet<string>): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (const i of items) {
    if (!selected.has(i.id)) continue
    count++
    bytes += i.bytes
  }
  return { count, bytes }
}

/**
 * 把已选 id 按原生单次上限切批。
 *
 * @param ids 已选 id
 * @param size 每批条数，缺省 {@link DELETE_BATCH}
 * @returns 分批后的二维数组
 */
export function chunkIds(ids: string[], size = DELETE_BATCH): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * 合并多批删除结果。
 *
 * @param parts 各批结果
 * @returns 总成功数、总释放字节数与全部失败项
 */
export function mergeDeleteResults(parts: DirDeleteResult[]): DirDeleteResult {
  return {
    deleted: parts.reduce((n, p) => n + p.deleted, 0),
    freedBytes: parts.reduce((n, p) => n + p.freedBytes, 0),
    failed: parts.flatMap((p) => p.failed),
  }
}

/**
 * 删除之后更新列表与勾选：已请求但没失败的项从列表移除，失败的保留（仍保持勾选，方便重试）。
 *
 * @param items 当前列表
 * @param requested 本次请求删除的 id
 * @param result 删除结果
 * @returns 新列表与新的勾选集合
 */
export function applyDeleteResult(items: DirItem[], requested: string[], result: DirDeleteResult): { items: DirItem[]; selected: Set<string> } {
  const failed = new Set(result.failed.map((f) => f.id))
  const gone = new Set(requested.filter((id) => !failed.has(id)))
  return { items: items.filter((i) => !gone.has(i.id)), selected: new Set(requested.filter((id) => failed.has(id))) }
}

/**
 * 扫描结果的一句话摘要。
 *
 * @param items 命中项
 * @param scanned 遍历节点数
 * @param truncated 是否不完整
 * @returns 摘要文字
 */
export function scanSummary(items: DirItem[], scanned: number, truncated: boolean): string {
  const total = items.reduce((n, i) => n + i.bytes, 0)
  const base = `共遍历 ${scanned} 项，命中 ${items.length} 项，合计 ${formatBytes(total)}`
  return truncated ? `${base}。结果不完整：命中过多、目录太深或节点太多，已截断。` : base
}

/**
 * 删除后的结果提示。
 *
 * @param r 合并后的删除结果
 * @returns 提示文字
 */
export function deleteSummary(r: DirDeleteResult): string {
  const ok = `已删除 ${r.deleted} 项，释放 ${formatBytes(r.freedBytes)}`
  return r.failed.length > 0 ? `${ok}；${r.failed.length} 项失败` : ok
}
