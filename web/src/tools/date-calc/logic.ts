// 日期计算器：公历日期 <-> 日序号（自 1970-01-01 的天数），整数运算，不碰本地时区

/** 支持的最小年份 */
export const MIN_YEAR = 1
/** 支持的最大年份 */
export const MAX_YEAR = 9999
/** 每月天数（平年） */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
/** 每周七天 */
const DAYS_PER_WEEK = 7
/** 星期名，下标 0 为周日 */
export const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 公历日期 */
export interface YMD {
  /** 年 */
  y: number
  /** 月（1-12） */
  m: number
  /** 日 */
  d: number
}

/**
 * 是否闰年。
 *
 * @param y 年份
 * @returns 闰年为 true
 */
export function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

/**
 * 某月天数。
 *
 * @param y 年
 * @param m 月（1-12）
 * @returns 天数
 * @example daysInMonth(2024, 2) // 29
 */
export function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeap(y) ? 29 : MONTH_DAYS[m - 1]
}

/**
 * 日期是否合法（年份在支持范围内、月日存在）。
 *
 * @param x 日期
 * @returns 合法为 true
 */
export function isValidYMD(x: YMD): boolean {
  return (
    Number.isInteger(x.y) &&
    Number.isInteger(x.m) &&
    Number.isInteger(x.d) &&
    x.y >= MIN_YEAR &&
    x.y <= MAX_YEAR &&
    x.m >= 1 &&
    x.m <= 12 &&
    x.d >= 1 &&
    x.d <= daysInMonth(x.y, x.m)
  )
}

/**
 * 日期转日序号（1970-01-01 为 0）。
 *
 * @param x 合法日期
 * @returns 日序号
 * @example toDayNumber({ y: 1970, m: 1, d: 2 }) // 1
 */
export function toDayNumber(x: YMD): number {
  const y = x.m <= 2 ? x.y - 1 : x.y
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = (x.m + 9) % 12
  const doy = Math.floor((153 * mp + 2) / 5) + x.d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/**
 * 日序号转日期。
 *
 * @param n 日序号
 * @returns 日期
 * @example fromDayNumber(0) // { y: 1970, m: 1, d: 1 }
 */
export function fromDayNumber(n: number): YMD {
  const z = n + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d }
}

/** 日期解析结果 */
export type DateParse = { ok: true; value: YMD } | { ok: false; error: string }

/**
 * 解析 `YYYY-MM-DD`（也接受 `/`、`.` 分隔）。
 *
 * @param text 日期文本
 * @returns 成功带日期，失败带提示
 * @example parseDate('2024-02-29') // { ok: true, value: { y: 2024, m: 2, d: 29 } }
 */
export function parseDate(text: string): DateParse {
  const s = text.trim()
  if (!s) return { ok: false, error: '请选择日期' }
  const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (!m) return { ok: false, error: '日期格式应为 年-月-日' }
  const value = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  if (!isValidYMD(value)) return { ok: false, error: '这一天不存在，或年份超出 1 到 9999' }
  return { ok: true, value }
}

/**
 * 日期格式化为 `YYYY-MM-DD`。
 *
 * @param x 日期
 * @returns 文本
 */
export function formatDate(x: YMD): string {
  return `${String(x.y).padStart(4, '0')}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`
}

/**
 * 星期几。
 *
 * @param n 日序号
 * @returns 0 到 6，0 为周日
 */
export function weekday(n: number): number {
  return (((n + 4) % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK // 1970-01-01 是周四
}

/**
 * 一年中的第几天。
 *
 * @param x 日期
 * @returns 1 起算
 */
export function dayOfYear(x: YMD): number {
  return toDayNumber(x) - toDayNumber({ y: x.y, m: 1, d: 1 }) + 1
}

/**
 * 日期加减若干月，月末溢出取当月最后一天（1-31 加 1 个月 = 2-28/29）。
 *
 * @param x 起始日期
 * @param months 月数，可为负
 * @returns 新日期；年份越界返回 null
 */
export function addMonths(x: YMD, months: number): YMD | null {
  const idx = x.y * 12 + (x.m - 1) + months
  const y = Math.floor(idx / 12)
  const m = idx - y * 12 + 1
  if (y < MIN_YEAR || y > MAX_YEAR) return null
  return { y, m, d: Math.min(x.d, daysInMonth(y, m)) }
}

/** 推算的单位 */
export type ShiftUnit = 'day' | 'week' | 'month' | 'year'

/**
 * 按单位加减日期。
 *
 * @param x 起始日期
 * @param amount 数量，可为负
 * @param unit 单位：日、周、月、年
 * @returns 新日期；超出支持年份范围返回 null
 * @example shiftDate({ y: 2024, m: 1, d: 31 }, 1, 'month') // { y: 2024, m: 2, d: 29 }
 */
export function shiftDate(x: YMD, amount: number, unit: ShiftUnit): YMD | null {
  let r: YMD | null
  if (unit === 'day' || unit === 'week') {
    r = fromDayNumber(toDayNumber(x) + amount * (unit === 'week' ? DAYS_PER_WEEK : 1))
  } else {
    r = addMonths(x, unit === 'year' ? amount * 12 : amount)
  }
  return r && r.y >= MIN_YEAR && r.y <= MAX_YEAR ? r : null
}

/** 日期间隔 */
export interface Interval {
  /** 相差总天数（b - a，可为负） */
  totalDays: number
  /** 整年数（绝对值） */
  years: number
  /** 剩余月数 */
  months: number
  /** 剩余天数 */
  days: number
}

/**
 * 两日期之差。年月日部分按「先整月、再余天」，与方向无关（始终从较早日期数起）。
 *
 * @param a 日期 a
 * @param b 日期 b
 * @param inclusive 为 true 时含首尾（总天数与余天各 +1 天计算）
 * @returns 间隔
 * @example dateDiff({y:2024,m:1,d:31},{y:2024,m:3,d:1},false) // 总 30 天，1 月 1 天
 */
export function dateDiff(a: YMD, b: YMD, inclusive: boolean): Interval {
  const na = toDayNumber(a)
  const nb = toDayNumber(b)
  const [early, late] = na <= nb ? [a, b] : [b, a]
  let months = (late.y - early.y) * 12 + (late.m - early.m)
  if (late.d < early.d) months -= 1
  const anchor = addMonths(early, months) as YMD
  const lateN = toDayNumber(late) + (inclusive ? 1 : 0)
  const days = lateN - toDayNumber(anchor)
  const sign = na <= nb ? 1 : -1
  const total = Math.abs(nb - na) + (inclusive ? 1 : 0)
  return { totalDays: sign * total, years: Math.floor(months / 12), months: months % 12, days }
}
