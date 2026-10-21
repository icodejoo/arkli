// 网速测试的纯逻辑：延迟采样与统计、速率格式化、历史记录读写
import { netTcp, type NetCallFn } from '@/native/net'
import { createToolStorage, type ToolStorage } from '@/shared/toolStorage'

/** 延迟测试目标主机（Cloudflare 公共 DNS） */
export const LATENCY_HOST = '1.1.1.1'
/** 延迟测试目标端口 */
export const LATENCY_PORT = 443
/** 延迟采样次数 */
export const LATENCY_TIMES = 5
/** 单次 TCP 连接超时（毫秒） */
export const LATENCY_TIMEOUT_MS = 3000
/** 下行测速地址：Cloudflare 提供约 25MB 的随机数据 */
export const SPEED_URL = 'https://speed.cloudflare.com/__down?bytes=25000000'
/** 下行最多下载字节数 */
export const SPEED_MAX_BYTES = 25_000_000
/** 下行最长时长（毫秒） */
export const SPEED_DURATION_MS = 8000
/** 历史记录保留条数 */
export const HISTORY_MAX = 10
/** 工具持久缓存的命名空间 */
export const TOOL_NS = 'speed-test'
/** 历史记录的缓存键 */
export const HISTORY_STORE_KEY = 'history'
/** 旧版 localStorage 里历史记录的键（仅用于迁移） */
export const HISTORY_KEY = 'arkli.speed-test.history.v1'

/** 每兆比特对应的比特数 */
const BITS_PER_MBIT = 1e6
/** 一兆字节对应的字节数 */
const BYTES_PER_MB = 1_000_000

/** 延迟统计 */
export interface LatencyStats {
  /** 采样次数 */
  count: number
  /** 成功次数 */
  ok: number
  /** 丢包率 0~1 */
  loss: number
  /** 最小延迟（毫秒），全部失败为 null */
  min: number | null
  /** 平均延迟（毫秒），全部失败为 null */
  avg: number | null
  /** 抖动（毫秒）：相邻成功样本差的平均绝对值，不足两个成功样本为 0；全部失败为 null */
  jitter: number | null
}

/**
 * 统计延迟样本。
 *
 * @param samples 每次连接的耗时（毫秒），失败为 null
 * @returns 最小 / 平均 / 抖动 / 丢包
 * @example latencyStats([10, 20, null, 30]) // { count: 4, ok: 3, loss: 0.25, min: 10, avg: 20, jitter: 10 }
 */
export function latencyStats(samples: Array<number | null>): LatencyStats {
  const oks = samples.filter((s): s is number => typeof s === 'number' && Number.isFinite(s))
  const count = samples.length
  if (!oks.length) return { count, ok: 0, loss: count ? 1 : 0, min: null, avg: null, jitter: null }
  let diff = 0
  for (let i = 1; i < oks.length; i++) diff += Math.abs(oks[i] - oks[i - 1])
  return {
    count,
    ok: oks.length,
    loss: (count - oks.length) / count,
    min: Math.min(...oks),
    avg: oks.reduce((a, b) => a + b, 0) / oks.length,
    jitter: oks.length > 1 ? diff / (oks.length - 1) : 0,
  }
}

/** 延迟采样选项 */
export interface MeasureOptions {
  /** 取消信号 */
  signal?: AbortSignal
  /** 每个样本出来后的回调（第几次、耗时或 null） */
  onSample?: (index: number, ms: number | null) => void
}

/**
 * 串行做若干次 TCP 连接，当作延迟样本。单次失败记 null，不中断；取消则抛出。
 *
 * @param host 主机
 * @param port 端口
 * @param times 次数
 * @param call 原生调用函数，默认走 bridge（测试时注入）
 * @param options 取消与逐个回调
 * @returns 样本数组（毫秒或 null）
 * @example const s = await measureLatency('1.1.1.1', 443, 5)
 */
export async function measureLatency(host: string, port: number, times: number, call?: NetCallFn, options: MeasureOptions = {}): Promise<Array<number | null>> {
  const out: Array<number | null> = []
  for (let i = 0; i < times; i++) {
    let ms: number | null = null
    try {
      const r = await netTcp(host, port, LATENCY_TIMEOUT_MS, call, options.signal)
      ms = r.ok ? r.elapsedMs : null
    } catch (e) {
      if (options.signal?.aborted) throw e
    }
    out.push(ms)
    options.onSample?.(i, ms)
  }
  return out
}

/**
 * 比特每秒转成 Mbps 文本：<10 保留 2 位，<100 保留 1 位，其余取整。
 *
 * @param bps 比特每秒
 * @returns 如 `23.4 Mbps`；无效值为 `—`
 * @example formatMbps(23_400_000) // '23.4 Mbps'
 */
export function formatMbps(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return '—'
  const m = bps / BITS_PER_MBIT
  return `${m < 10 ? m.toFixed(2) : m < 100 ? m.toFixed(1) : m.toFixed(0)} Mbps`
}

/**
 * 比特每秒转成 MB/s 文本（1MB=1,000,000 字节）。
 *
 * @param bps 比特每秒
 * @returns 如 `2.93 MB/s`；无效值为 `—`
 * @example formatMBps(23_400_000) // '2.93 MB/s'
 */
export function formatMBps(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return '—'
  return `${(bps / 8 / BYTES_PER_MB).toFixed(2)} MB/s`
}

/**
 * 毫秒文本，一位小数。
 *
 * @param ms 毫秒，null 显示 `—`
 * @returns 如 `12.3 ms`
 * @example formatMs(12.34) // '12.3 ms'
 */
export function formatMs(ms: number | null): string {
  return ms === null || !Number.isFinite(ms) ? '—' : `${ms.toFixed(1)} ms`
}

/** 一条历史记录 */
export interface HistoryEntry {
  /** 测试时间戳（毫秒） */
  ts: number
  /** 最小延迟（毫秒），失败为 null */
  latencyMin: number | null
  /** 平均延迟（毫秒），失败为 null */
  latencyAvg: number | null
  /** 抖动（毫秒），失败为 null */
  jitter: number | null
  /** 下行速率（比特每秒），没测或失败为 null */
  bps: number | null
}

/**
 * 把新记录放到最前，只保留最近 N 条，不改原数组。
 *
 * @param list 现有历史（新→旧）
 * @param entry 新记录
 * @param max 最多保留几条，默认 {@link HISTORY_MAX}
 * @returns 新历史
 * @example pushHistory([], { ts: 1, latencyMin: 5, latencyAvg: 6, jitter: 1, bps: 8e6 }).length // 1
 */
export function pushHistory(list: HistoryEntry[], entry: HistoryEntry, max = HISTORY_MAX): HistoryEntry[] {
  return [entry, ...list].slice(0, max)
}

/** 数值或 null，其余视为非法 */
function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 解析缓存里的历史，丢掉不合规的条目。
 *
 * @param raw 已解析的数组，或 JSON 原文；可空
 * @returns 历史数组（至多 {@link HISTORY_MAX} 条）；坏数据为空数组
 * @example parseHistory('[]') // []
 */
export function parseHistory(raw: unknown): HistoryEntry[] {
  if (!raw) return []
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(data)) return []
  const out: HistoryEntry[] = []
  for (const it of data as Array<Record<string, unknown>>) {
    if (!it || typeof it !== 'object' || typeof it.ts !== 'number') continue
    const latencyMin = numOrNull(it.latencyMin)
    const latencyAvg = numOrNull(it.latencyAvg)
    const jitter = numOrNull(it.jitter)
    const bps = numOrNull(it.bps)
    if (latencyMin === undefined || latencyAvg === undefined || jitter === undefined || bps === undefined) continue
    out.push({ ts: it.ts, latencyMin, latencyAvg, jitter, bps })
  }
  return out.slice(0, HISTORY_MAX)
}

/**
 * 读历史；存储不可用时返回空数组；首次读取时迁移旧键。
 *
 * @param store 持久缓存，默认本工具命名空间
 * @returns 历史（新→旧）
 * @example const h = loadHistory()
 */
export function loadHistory(store: ToolStorage = createToolStorage(TOOL_NS)): HistoryEntry[] {
  store.adoptLegacy(HISTORY_KEY, HISTORY_STORE_KEY)
  return parseHistory(store.get<unknown>(HISTORY_STORE_KEY, null))
}

/**
 * 写历史；存储不可用时静默忽略。
 *
 * @param list 历史
 * @param store 持久缓存，默认本工具命名空间
 * @returns 是否写入成功
 * @example saveHistory(list)
 */
export function saveHistory(list: HistoryEntry[], store: ToolStorage = createToolStorage(TOOL_NS)): boolean {
  return store.set(HISTORY_STORE_KEY, list.slice(0, HISTORY_MAX))
}

/**
 * 时间戳转本地 `MM-DD HH:mm`。
 *
 * @param ts 毫秒时间戳
 * @returns 文本
 * @example formatTime(new Date(2024, 0, 2, 3, 4).getTime()) // '01-02 03:04'
 */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
