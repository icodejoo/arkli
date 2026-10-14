/**
 * 缓存管理封装：占用统计与一键清理。
 * 对应原生 `native.cache.stats` / `native.cache.clear`，契约见 docs/design/bridge-protocol.md「native.cache.stats / native.cache.clear」。
 *
 * 无宿主时全部抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall } from './bridge'
import { requireNative, type CallFn } from './system'
import { formatBytes } from '@/shared/image-calc'

/** 方法名常量 */
export const CACHE_METHODS = {
  stats: 'native.cache.stats',
  clear: 'native.cache.clear',
} as const

/** 某个缓存子目录的占用 */
export interface CacheDirStat {
  /** 字节数 */
  bytes: number
  /** 文件数 */
  files: number
}

/** 缓存占用 */
export interface CacheStats {
  /** 总字节数 */
  bytes: number
  /** 总文件数 */
  files: number
  /** 按缓存根下第一级目录分组，根目录直属文件归入 `_root` */
  byDir: Record<string, CacheDirStat>
}

/** 清理结果 */
export interface CacheClearResult {
  /** 释放的字节数 */
  freedBytes: number
  /** 删除的文件数 */
  deleted: number
  /** 因正在使用或刚写入而保留的文件数 */
  skipped: number
}

/**
 * 查询缓存占用。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 总量与分目录占用
 * @example const { bytes, files } = await getCacheStats()
 */
export async function getCacheStats(call: CallFn = bridgeCall): Promise<CacheStats> {
  requireNative(CACHE_METHODS.stats)
  return call<CacheStats>(CACHE_METHODS.stats, {})
}

/**
 * 清理缓存。会跳过正在写入的临时文件与最近 1 分钟内改过的文件。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 释放量、删除数、保留数
 * @example const { freedBytes } = await clearCache()
 */
export async function clearCache(call: CallFn = bridgeCall): Promise<CacheClearResult> {
  requireNative(CACHE_METHODS.clear)
  return call<CacheClearResult>(CACHE_METHODS.clear, {})
}

/**
 * 占用的一行文案，如“缓存占用 3.2 MB（12 个文件）”。
 *
 * @param s 占用统计
 */
export function statsText(s: CacheStats): string {
  return `缓存占用 ${formatBytes(s.bytes)}（${s.files} 个文件）`
}

/**
 * 清理完成的一行文案，如“已释放 3.2 MB（删除 12 个文件）”。
 *
 * @param r 清理结果
 */
export function clearText(r: CacheClearResult): string {
  return `已释放 ${formatBytes(r.freedBytes)}（删除 ${r.deleted} 个文件）`
}
