/**
 * 文件夹清理封装：选择文件夹（SAF 授权）、已授权列表、扫描、删除。
 * 对应原生 `native.dir.*`，契约见 docs/design/bridge-protocol.md「文件夹清理方法」。
 *
 * 只靠系统文件夹选择器授权，不申请任何存储权限。删除走 SAF，不经回收站，删除后无法恢复。
 * 无宿主时全部抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall, on as bridgeOn } from './bridge'
import { requireNative, type CallFn } from './system'
import type { OnFn } from './tts'

/** 方法名常量 */
export const DIR_METHODS = {
  pick: 'native.dir.pick',
  list: 'native.dir.list',
  forget: 'native.dir.forget',
  scan: 'native.dir.scan',
  delete: 'native.dir.delete',
} as const

/** 扫描进度事件名 */
export const DIR_EVENT_PROGRESS = 'dir.progress'

/** 扫描模式：大文件 / 空文件与空文件夹 / 安装包 / 全部列出 */
export type DirScanMode = 'large' | 'empty' | 'apk' | 'all'

/** 一个已授权的文件夹 */
export interface DirFolder {
  /** 不透明令牌，后续调用都带它 */
  token: string
  /** 显示名 */
  name: string
}

/** 扫描参数 */
export interface DirScanOptions {
  /** 模式 */
  mode: DirScanMode
  /** 大文件阈值（字节），缺省 50MB */
  minBytes?: number
  /** 命中数上限，缺省 2000，最大 5000 */
  maxItems?: number
  /** 最大下探层数，缺省 12，最大 20 */
  maxDepth?: number
}

/** 一个扫描命中项 */
export interface DirItem {
  /** 本次扫描内的句柄，删除时回传 */
  id: string
  /** 显示名 */
  name: string
  /** 相对所选文件夹的路径 */
  relPath: string
  /** 字节数，文件夹为 0 */
  bytes: number
  /** 最后修改时间（毫秒时间戳），未知为 0 */
  lastModifiedMs: number
  /** 是否文件夹 */
  isDir: boolean
}

/** 扫描结果 */
export interface DirScanResult {
  /** 命中项 */
  items: DirItem[]
  /** 遍历过的节点数 */
  scanned: number
  /** 是否不完整（命中数被截断、节点超上限或层级超限） */
  truncated: boolean
}

/** 删除结果 */
export interface DirDeleteResult {
  /** 成功删除的条数 */
  deleted: number
  /** 释放的字节数 */
  freedBytes: number
  /** 失败项 */
  failed: Array<{ id: string; message: string }>
}

/** 带取消信号的调用选项：长任务不设超时 */
function longOptions(signal?: AbortSignal): { timeoutMs?: number } {
  return { timeoutMs: 0, signal } as { timeoutMs?: number }
}

/**
 * 弹出系统文件夹选择器并授权。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 选中的文件夹；用户取消返回 null
 * @example const dir = await pickDir()
 */
export async function pickDir(call: CallFn = bridgeCall): Promise<DirFolder | null> {
  requireNative(DIR_METHODS.pick)
  const r = await call<{ token: string | null; name: string | null }>(DIR_METHODS.pick, {}, { timeoutMs: 0 })
  return r.token ? { token: r.token, name: r.name ?? '' } : null
}

/**
 * 列出已授权的文件夹。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 文件夹列表
 * @example const dirs = await listDirs()
 */
export async function listDirs(call: CallFn = bridgeCall): Promise<DirFolder[]> {
  requireNative(DIR_METHODS.list)
  const r = await call<{ items: DirFolder[] }>(DIR_METHODS.list, {})
  return r.items
}

/**
 * 移除一个文件夹的授权，不动里面的文件。
 *
 * @param token 文件夹令牌
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 是否确有这条授权
 * @example await forgetDir(dir.token)
 */
export async function forgetDir(token: string, call: CallFn = bridgeCall): Promise<boolean> {
  requireNative(DIR_METHODS.forget)
  const r = await call<{ forgotten: boolean }>(DIR_METHODS.forget, { token })
  return r.forgotten === true
}

/**
 * 扫描文件夹。可取消；进度通过 `onProgress` 回调（已遍历的节点数）。
 *
 * @param token 文件夹令牌
 * @param options 扫描参数，值为 undefined 的项不传
 * @param extra 取消信号与进度回调，可选
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param on 事件订阅函数，默认走 bridge（仅测试注入）
 * @returns 命中项与统计
 * @example const r = await scanDir(dir.token, { mode: 'large', minBytes: 100 << 20 })
 */
export async function scanDir(
  token: string,
  options: DirScanOptions,
  extra: { signal?: AbortSignal; onProgress?: (scanned: number) => void } = {},
  call: CallFn = bridgeCall,
  on: OnFn = bridgeOn,
): Promise<DirScanResult> {
  requireNative(DIR_METHODS.scan)
  const params: Record<string, unknown> = { token, mode: options.mode }
  if (options.minBytes !== undefined) params.minBytes = options.minBytes
  if (options.maxItems !== undefined) params.maxItems = options.maxItems
  if (options.maxDepth !== undefined) params.maxDepth = options.maxDepth
  const off = extra.onProgress
    ? on(DIR_EVENT_PROGRESS, (d) => extra.onProgress?.((d as { scanned: number }).scanned))
    : null
  try {
    return await call<DirScanResult>(DIR_METHODS.scan, params, longOptions(extra.signal))
  } finally {
    off?.()
  }
}

/**
 * 删除扫描结果里的若干项，不经回收站，无法恢复。每次最多 500 项。
 *
 * @param token 文件夹令牌
 * @param ids 要删除的项 id（来自最近一次扫描）
 * @param signal 取消信号，可选
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 成功数、释放字节数与失败项
 * @example const r = await deleteDirItems(dir.token, ['it:ab12'])
 */
export async function deleteDirItems(token: string, ids: string[], signal?: AbortSignal, call: CallFn = bridgeCall): Promise<DirDeleteResult> {
  requireNative(DIR_METHODS.delete)
  return call<DirDeleteResult>(DIR_METHODS.delete, { token, ids }, longOptions(signal))
}
