// 倒数日：按日历日计算，不涉及时区与时分秒；农历重复暂不支持
import type { ToolStorage } from '@/shared/toolStorage'

/** 持久缓存里事件列表的键 */
export const EVENTS_KEY = 'events'
/** 旧版 localStorage 里事件列表的整键名 */
export const LEGACY_EVENTS_KEY = 'arkli.countdown.events'

/** 一天的毫秒数 */
const MS_PER_DAY = 86400000
/** 日期格式 YYYY-MM-DD 的校验 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 一个倒数日事件 */
export interface CountdownEvent {
  /** 唯一 id */
  id: string
  /** 名称 */
  name: string
  /** 日期，YYYY-MM-DD */
  date: string
  /** 是否每年重复 */
  yearly: boolean
}

/** 带计算结果的事件 */
export interface CountdownItem extends CountdownEvent {
  /** 距目标日的天数：正数还有 N 天，负数已过 N 天，0 为今天 */
  days: number
  /** 实际参照的目标日期（每年重复时为下一次） */
  target: string
}

/**
 * 把 YYYY-MM-DD 解析成 UTC 天序号。
 *
 * @param s 日期串
 * @returns 天序号；格式或日期不合法返回 null
 * @example parseDay('2024-02-29')
 */
export function parseDay(s: string): number | null {
  const m = DATE_RE.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const dt = new Date(t)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return t / MS_PER_DAY
}

/**
 * 天序号转 YYYY-MM-DD。
 *
 * @param day 天序号
 * @returns 日期串
 */
export function formatDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

/**
 * 把本地时间的今天转成天序号（取本地年月日）。
 *
 * @param now 当前时间
 * @returns 天序号
 */
export function todayDay(now: Date = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY
}

/** 判断闰年 */
function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

/** 取某年的"月-日"对应天序号，2 月 29 日在平年落到 2 月 28 日 */
function dayInYear(year: number, month: number, date: number): number {
  const d = month === 2 && date === 29 && !isLeap(year) ? 28 : date
  return Date.UTC(year, month - 1, d) / MS_PER_DAY
}

/**
 * 计算一个事件相对今天的天数。每年重复的事件取今天及以后最近的一次。
 *
 * @param ev 事件
 * @param today 今天的天序号
 * @returns 带天数的事件；日期不合法返回 null
 * @example calcItem({ id: '1', name: '生日', date: '2000-05-01', yearly: true }, todayDay())
 */
export function calcItem(ev: CountdownEvent, today: number): CountdownItem | null {
  const base = parseDay(ev.date)
  if (base === null) return null
  let target = base
  if (ev.yearly) {
    const [, mo, d] = ev.date.split('-').map(Number)
    const y = new Date(today * MS_PER_DAY).getUTCFullYear()
    target = dayInYear(y, mo, d)
    if (target < today) target = dayInYear(y + 1, mo, d)
  }
  return { ...ev, days: target - today, target: formatDay(target) }
}

/**
 * 计算并排序：未到的（含今天）按剩余天数升序在前，已过的按过去天数升序在后。
 *
 * @param events 事件列表
 * @param today 今天的天序号
 * @returns 排好序的结果
 */
export function buildList(events: CountdownEvent[], today: number): CountdownItem[] {
  const items = events.map((e) => calcItem(e, today)).filter((x): x is CountdownItem => x !== null)
  return items.sort((a, b) => {
    const aFuture = a.days >= 0
    const bFuture = b.days >= 0
    if (aFuture !== bFuture) return aFuture ? -1 : 1
    return aFuture ? a.days - b.days : b.days - a.days
  })
}

/**
 * 天数的中文描述。
 *
 * @param days 天数（正为未到）
 * @returns 如 "还有 3 天" / "已过 5 天" / "今天"
 */
export function describeDays(days: number): string {
  if (days === 0) return '今天'
  return days > 0 ? `还有 ${days} 天` : `已过 ${-days} 天`
}

/**
 * 校验事件输入。
 *
 * @param name 名称
 * @param date 日期
 * @returns 错误提示；通过返回空串
 */
export function validateEvent(name: string, date: string): string {
  if (!name.trim()) return '请填写名称'
  if (parseDay(date) === null) return '请选择有效日期'
  return ''
}

/**
 * 从存储的 JSON 串解析事件列表，格式不对的条目丢弃。
 *
 * @param raw JSON 串
 * @returns 事件列表
 */
export function parseStored(raw: string | null): CountdownEvent[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (x): x is CountdownEvent =>
        !!x &&
        typeof x.id === 'string' &&
        typeof x.name === 'string' &&
        typeof x.date === 'string' &&
        typeof x.yearly === 'boolean' &&
        parseDay(x.date) !== null,
    )
  } catch {
    return []
  }
}

/**
 * 读事件列表：先一次性迁移旧键，再按格式过滤坏条目。
 *
 * @param store 倒数日的持久缓存
 * @returns 事件列表
 * @example
 * const events = loadEvents(createToolStorage('countdown'))
 */
export function loadEvents(store: ToolStorage): CountdownEvent[] {
  store.adoptLegacy(LEGACY_EVENTS_KEY, EVENTS_KEY)
  return parseStored(JSON.stringify(store.get<unknown>(EVENTS_KEY, [])))
}

/**
 * 保存事件列表。
 *
 * @param store 倒数日的持久缓存
 * @param events 事件列表
 * @example
 * saveEvents(store, events.value)
 */
export function saveEvents(store: ToolStorage, events: CountdownEvent[]): void {
  store.set(EVENTS_KEY, events)
}
