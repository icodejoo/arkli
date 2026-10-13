// 时间计算器：时分秒加减、两时刻之差、时长换算，全部以整数秒运算

/** 每分钟秒数 */
const SEC_PER_MIN = 60
/** 每小时秒数 */
const SEC_PER_HOUR = 3600
/** 每天秒数 */
export const SEC_PER_DAY = 86400

/** 时长拆解结果 */
export interface Duration {
  /** 是否为负 */
  negative: boolean
  /** 天 */
  days: number
  /** 时（0-23） */
  hours: number
  /** 分（0-59） */
  minutes: number
  /** 秒（0-59） */
  seconds: number
}

/** 解析结果 */
export type TimeParse = { ok: true; seconds: number } | { ok: false; error: string }

/**
 * 解析 `时:分:秒` 或 `时:分` 文本为秒数。小时不限 24（便于表示时长），分秒需在 0 到 59。
 *
 * @param text 如 `12:30:45`、`36:00`
 * @returns 秒数或错误提示
 * @example parseHms('01:02:03') // { ok: true, seconds: 3723 }
 */
export function parseHms(text: string): TimeParse {
  const s = text.trim()
  if (!s) return { ok: false, error: '请输入时间' }
  const m = /^(\d{1,6}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s)
  if (!m) return { ok: false, error: '格式应为 时:分:秒，例如 12:30:45' }
  const h = Number(m[1])
  const min = Number(m[2])
  const sec = Number(m[3] ?? 0)
  if (min >= SEC_PER_MIN || sec >= SEC_PER_MIN) return { ok: false, error: '分和秒要在 0 到 59 之间' }
  return { ok: true, seconds: h * SEC_PER_HOUR + min * SEC_PER_MIN + sec }
}

/**
 * 把秒数拆成天/时/分/秒。
 *
 * @param total 总秒数（可为负）
 * @returns 拆解结果
 * @example breakDown(90061) // { days: 1, hours: 1, minutes: 1, seconds: 1, negative: false }
 */
export function breakDown(total: number): Duration {
  const negative = total < 0
  let rest = Math.abs(Math.trunc(total))
  const days = Math.floor(rest / SEC_PER_DAY)
  rest -= days * SEC_PER_DAY
  const hours = Math.floor(rest / SEC_PER_HOUR)
  rest -= hours * SEC_PER_HOUR
  const minutes = Math.floor(rest / SEC_PER_MIN)
  return { negative, days, hours, minutes, seconds: rest - minutes * SEC_PER_MIN }
}

/** 两位补零 */
const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 格式化时长为 `[负][N天 ]HH:MM:SS`。
 *
 * @param total 总秒数
 * @returns 文本
 * @example formatDuration(90061) // '1天 01:01:01'
 */
export function formatDuration(total: number): string {
  const d = breakDown(total)
  const hms = `${pad2(d.hours)}:${pad2(d.minutes)}:${pad2(d.seconds)}`
  return (d.negative ? '-' : '') + (d.days ? `${d.days}天 ` : '') + hms
}

/** 时刻加减结果 */
export interface ClockResult {
  /** 相对起始日偏移的天数（负为前一天） */
  dayOffset: number
  /** 当天的时刻文本 HH:MM:SS */
  time: string
}

/**
 * 时刻加上或减去一段时长，跨天进位。
 *
 * @param base 起始时刻秒数（0 到 86399）
 * @param delta 时长秒数（非负）
 * @param sign 1 加、-1 减
 * @returns 天数偏移与结果时刻
 * @example addClock(82800, 7200, 1) // { dayOffset: 1, time: '01:00:00' }
 */
export function addClock(base: number, delta: number, sign: 1 | -1): ClockResult {
  const total = base + sign * delta
  const dayOffset = Math.floor(total / SEC_PER_DAY)
  const sod = total - dayOffset * SEC_PER_DAY
  const d = breakDown(sod)
  return { dayOffset, time: `${pad2(d.hours)}:${pad2(d.minutes)}:${pad2(d.seconds)}` }
}

/**
 * 两个时刻之差（b - a）。
 *
 * @param a 起始秒数
 * @param b 结束秒数
 * @param crossDay 为 true 时，b 早于 a 视为次日（差值加 24 小时）
 * @returns 秒数差
 * @example clockDiff(82800, 3600, true) // 7200
 */
export function clockDiff(a: number, b: number, crossDay: boolean): number {
  const diff = b - a
  return crossDay && diff < 0 ? diff + SEC_PER_DAY : diff
}

/** 时长换算行 */
export interface DurationUnit {
  /** 单位名 */
  name: string
  /** 数值 */
  value: number
}

/**
 * 把一段秒数换算成秒/分/时/天的总量。
 *
 * @param total 总秒数
 * @returns 各单位数值（保留 6 位小数）
 * @example durationUnits(5400) // [{ name: '秒', value: 5400 }, ... { name: '小时', value: 1.5 }]
 */
export function durationUnits(total: number): DurationUnit[] {
  const round = (n: number): number => Math.round(n * 1e6) / 1e6
  return [
    { name: '秒', value: total },
    { name: '分钟', value: round(total / SEC_PER_MIN) },
    { name: '小时', value: round(total / SEC_PER_HOUR) },
    { name: '天', value: round(total / SEC_PER_DAY) },
  ]
}
