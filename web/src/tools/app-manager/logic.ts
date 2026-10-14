// 应用管理：列表过滤、排序、格式化，以及限制并发的图标加载器（纯逻辑）
import type { AppInfo } from '@/native/apps'

/** 排序方式：名称 / 安装时间（新的在前） / 大小（大的在前） */
export type SortKey = 'name' | 'installed' | 'size'
/** 图标请求的最大并发 */
export const ICON_CONCURRENCY = 3
/** 排序方式选项 */
export const SORT_OPTIONS: Array<{ key: SortKey; name: string }> = [
  { key: 'name', name: '名称' },
  { key: 'installed', name: '安装时间' },
  { key: 'size', name: '大小' },
]

/**
 * 按关键字与「是否显示系统应用」过滤。关键字匹配应用名或包名，不分大小写，多个词用空格隔开时要全部命中。
 *
 * @param apps 应用列表
 * @param query 搜索词，可为空
 * @param showSystem 是否包含系统应用
 * @returns 过滤后的新列表
 * @example filterApps(apps, '微信 mm', false)
 */
export function filterApps(apps: AppInfo[], query: string, showSystem: boolean): AppInfo[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return apps.filter((a) => {
    if (!showSystem && a.isSystem) return false
    if (words.length === 0) return true
    const hay = `${a.label} ${a.pkg}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/**
 * 排序，返回新数组。名称按中文拼音序；安装时间新的在前；大小大的在前；并列时按名称、包名保证稳定。
 *
 * @param apps 应用列表
 * @param key 排序方式
 * @returns 排好序的新列表
 */
export function sortApps(apps: AppInfo[], key: SortKey): AppInfo[] {
  const byName = (a: AppInfo, b: AppInfo): number => a.label.localeCompare(b.label, 'zh-Hans-CN') || a.pkg.localeCompare(b.pkg)
  const list = apps.slice()
  if (key === 'installed') return list.sort((a, b) => b.firstInstallMs - a.firstInstallMs || byName(a, b))
  if (key === 'size') return list.sort((a, b) => b.apkBytes - a.apkBytes || byName(a, b))
  return list.sort(byName)
}

/**
 * 字节数转可读大小。
 *
 * @param bytes 字节数
 * @returns 如 `0 B`、`1.5 KB`、`23.4 MB`、`1.20 GB`
 * @example formatBytes(1536) // '1.5 KB'
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : i === 3 ? 2 : 1
  return `${v.toFixed(digits)} ${units[i]}`
}

/**
 * 时间戳格式化成本地 `YYYY-MM-DD HH:mm`。
 *
 * @param ms 毫秒时间戳；0 或非法返回「未知」
 * @returns 文本
 */
export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 列表摘要：共几个应用、安装包合计多大。
 *
 * @param apps 应用列表
 * @returns 如 `共 42 个应用，安装包合计 1.2 GB`
 */
export function summarize(apps: AppInfo[]): string {
  const total = apps.reduce((n, a) => n + a.apkBytes, 0)
  return `共 ${apps.length} 个应用，安装包合计 ${formatBytes(total)}`
}

/**
 * 并发限制器：同时最多跑 max 个任务，其余排队，先到先得。
 *
 * @param max 最大并发，至少 1
 * @returns 提交任务的函数，返回任务本身的结果（失败原样抛出，不影响队列）
 * @example const run = createLimiter(3); await run(() => fetchIcon('a.b'))
 */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(max))
  let running = 0
  const queue: Array<() => void> = []
  const next = (): void => {
    if (running >= limit) return
    const start = queue.shift()
    if (start) start()
  }
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        running++
        task().then(resolve, reject).finally(() => {
          running--
          next()
        })
      })
      next()
    })
}

/** 图标加载器 */
export interface IconLoader {
  /** 取某应用的图标，同一个包只会请求一次；失败得到 null（之后不再重试） */
  get(pkg: string): Promise<string | null>
}

/**
 * 创建图标加载器：同包去重、结果缓存、限制并发。
 *
 * @param load 真正去取图标的函数，返回可显示的 URL
 * @param concurrency 最大并发，缺省 3
 * @returns 加载器
 * @example const icons = createIconLoader((pkg) => appIcon(pkg).then(appFileUrl))
 */
export function createIconLoader(load: (pkg: string) => Promise<string>, concurrency = ICON_CONCURRENCY): IconLoader {
  const run = createLimiter(concurrency)
  const cache = new Map<string, Promise<string | null>>()
  return {
    get(pkg) {
      let p = cache.get(pkg)
      if (!p) {
        p = run(() => load(pkg)).catch(() => null)
        cache.set(pkg, p)
      }
      return p
    },
  }
}
