// 噪音测量：等级划分、校准偏移、统计、环形缓冲与折线坐标（纯逻辑）。分贝值是未校准的近似值，仅供参考

/** 噪音等级的色调，页面据此取颜色 */
export type Tone = 'ok' | 'warn' | 'bad'

/** 「很安静」的上界（不含） */
export const LEVEL_QUIET_MAX = 30
/** 「安静」的上界（不含） */
export const LEVEL_CALM_MAX = 50
/** 「一般」的上界（不含） */
export const LEVEL_NORMAL_MAX = 70
/** 「嘈杂」的上界（含）；超过即「有害听力」 */
export const LEVEL_LOUD_MAX = 85

/** 校准偏移的范围（dB） */
export const OFFSET_RANGE = { min: -20, max: 20 } as const
/** 显示分贝的上下限 */
export const DB_RANGE = { min: 0, max: 140 } as const
/** 表盘与折线图的显示范围（dB），常见环境噪音都落在这里面 */
export const GAUGE_RANGE = { min: 20, max: 120 } as const
/** 折线图保留的时长（毫秒） */
export const CHART_WINDOW_MS = 60_000
/** 校准偏移的存储键 */
export const OFFSET_KEY = 'arkli.noise-meter.offset'
/** 推送间隔（毫秒） */
export const SAMPLE_INTERVAL_MS = 100

/** 等级描述 */
export interface NoiseLevel {
  /** 中文描述 */
  label: string
  /** 色调 */
  tone: Tone
}

/**
 * 按分贝取等级：<30 很安静、30~50 安静、50~70 一般、70~85 嘈杂、>85 有害听力。
 *
 * @param db 分贝值
 * @returns 等级描述与色调
 * @example noiseLevel(60) // { label: '一般', tone: 'ok' }
 */
export function noiseLevel(db: number): NoiseLevel {
  if (db < LEVEL_QUIET_MAX) return { label: '很安静', tone: 'ok' }
  if (db < LEVEL_CALM_MAX) return { label: '安静', tone: 'ok' }
  if (db < LEVEL_NORMAL_MAX) return { label: '一般', tone: 'ok' }
  if (db <= LEVEL_LOUD_MAX) return { label: '嘈杂', tone: 'warn' }
  return { label: '有害听力', tone: 'bad' }
}

/**
 * 把校准偏移夹到 ±20 并取整到 0.5 dB。
 *
 * @param v 原始偏移
 * @returns 合法偏移；非数字返回 0
 */
export function clampOffset(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(OFFSET_RANGE.max, Math.max(OFFSET_RANGE.min, Math.round(v * 2) / 2))
}

/**
 * 叠加校准偏移并夹到 0~140。
 *
 * @param db 原生给的近似声压级
 * @param offset 校准偏移（dB）
 * @returns 显示用分贝
 */
export function applyOffset(db: number, offset: number): number {
  return Math.min(DB_RANGE.max, Math.max(DB_RANGE.min, db + offset))
}

/** 取本地存储，不可用时为 null */
function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * 读取保存的校准偏移。
 *
 * @param storage 存储对象，缺省用 localStorage（仅测试注入）
 * @returns 偏移（dB），读不到返回 0
 */
export function loadOffset(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): number {
  try {
    const raw = storage?.getItem(OFFSET_KEY)
    return raw == null ? 0 : clampOffset(Number(raw))
  } catch {
    return 0
  }
}

/**
 * 保存校准偏移，存储不可用时静默忽略。
 *
 * @param offset 偏移（dB）
 * @param storage 存储对象，缺省用 localStorage（仅测试注入）
 */
export function saveOffset(offset: number, storage: Pick<Storage, 'setItem'> | null = defaultStorage()): void {
  try {
    storage?.setItem(OFFSET_KEY, String(clampOffset(offset)))
  } catch {
    // 存储满或被禁用，忽略
  }
}

/**
 * 分贝值转表盘比例。
 *
 * @param db 分贝值
 * @returns 0~1，按 20~120 dB 线性映射
 */
export function gaugeFraction(db: number): number {
  const f = (db - GAUGE_RANGE.min) / (GAUGE_RANGE.max - GAUGE_RANGE.min)
  return Math.min(1, Math.max(0, f))
}

/**
 * 折线图要保留的点数。
 *
 * @param intervalMs 推送间隔（毫秒）
 * @param windowMs 时间窗，缺省 60 秒
 * @returns 点数，至少 1
 */
export function ringCapacity(intervalMs: number, windowMs = CHART_WINDOW_MS): number {
  return Math.max(1, Math.ceil(windowMs / Math.max(1, intervalMs)))
}

/**
 * 定长环形缓冲：满了就覆盖最旧的，不做数组搬移。
 *
 * 使用示例：`const r = new RingBuffer(600); r.push(42); r.values()`
 */
export class RingBuffer {
  /** 底层存储 */
  private readonly buf: number[]
  /** 下一次写入位置 */
  private head = 0
  /** 当前元素数 */
  private count = 0

  /**
   * @param capacity 容量，至少 1
   */
  constructor(readonly capacity: number) {
    this.buf = new Array<number>(Math.max(1, Math.floor(capacity))).fill(0)
  }

  /** 当前元素数 */
  get size(): number {
    return this.count
  }

  /**
   * 追加一个值。
   *
   * @param v 值
   */
  push(v: number): void {
    this.buf[this.head] = v
    this.head = (this.head + 1) % this.buf.length
    if (this.count < this.buf.length) this.count++
  }

  /**
   * 按时间从旧到新取出全部元素。
   *
   * @returns 新数组
   */
  values(): number[] {
    const n = this.buf.length
    const start = this.count < n ? 0 : this.head
    const out: number[] = []
    for (let i = 0; i < this.count; i++) out.push(this.buf[(start + i) % n])
    return out
  }

  /** 清空 */
  clear(): void {
    this.head = 0
    this.count = 0
  }
}

/** 最大 / 最小 / 平均的统计结果；还没数据时各项为 null */
export interface NoiseStatsView {
  /** 最小值 */
  min: number | null
  /** 最大值 */
  max: number | null
  /** 平均值 */
  avg: number | null
  /** 样本数 */
  count: number
}

/**
 * 累计最大 / 最小 / 平均，只记常数个数字，不保存历史。
 *
 * 使用示例：`const s = new StatsTracker(); s.add(40); s.view()`
 */
export class StatsTracker {
  /** 最小值 */
  private min = Infinity
  /** 最大值 */
  private max = -Infinity
  /** 累加和 */
  private sum = 0
  /** 样本数 */
  private n = 0

  /**
   * 加入一个样本。
   *
   * @param v 分贝值
   */
  add(v: number): void {
    if (v < this.min) this.min = v
    if (v > this.max) this.max = v
    this.sum += v
    this.n++
  }

  /**
   * 当前统计。
   *
   * @returns 最小、最大、平均与样本数
   */
  view(): NoiseStatsView {
    if (this.n === 0) return { min: null, max: null, avg: null, count: 0 }
    return { min: this.min, max: this.max, avg: this.sum / this.n, count: this.n }
  }

  /** 清零 */
  reset(): void {
    this.min = Infinity
    this.max = -Infinity
    this.sum = 0
    this.n = 0
  }
}

/**
 * 分贝显示文字，保留 1 位小数。
 *
 * @param db 分贝值，null 表示没有数据
 * @returns 如 `45.3`；null 返回 `--`
 */
export function formatDb(db: number | null): string {
  return db == null || !Number.isFinite(db) ? '--' : db.toFixed(1)
}

/**
 * 把一串分贝值换算成折线图的画布坐标，右端对齐当前时刻、越旧越靠左。
 *
 * @param values 从旧到新的分贝值
 * @param capacity 满屏对应的点数（右端为最新点）
 * @param width 画布宽
 * @param height 画布高
 * @returns 坐标点 [x, y]，y 向下；超出 20~120 dB 的值贴边
 */
export function chartPoints(values: number[], capacity: number, width: number, height: number): Array<[number, number]> {
  const step = capacity > 1 ? width / (capacity - 1) : 0
  const offset = capacity - values.length
  return values.map((v, i) => [(offset + i) * step, height * (1 - gaugeFraction(v))])
}
