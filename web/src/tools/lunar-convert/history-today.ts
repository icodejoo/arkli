// 历史上的今天：取维基百科 On This Day 的 events，解析精简、缓存、错误分类。
// 与 Vue 解耦；fetch 与存储都可注入，便于单测。数据来自维基百科（CC BY-SA 4.0）。

/** 接口地址前缀（中文维基 On This Day，只取 events） */
export const HISTORY_ENDPOINT = 'https://api.wikimedia.org/feed/v1/wikipedia/zh/onthisday/events'
/** 请求超时（毫秒） */
export const HISTORY_TIMEOUT_MS = 15000
/** 词条简介最大保留字数，防止缓存膨胀 */
export const EXTRACT_MAX = 300
/** sessionStorage 缓存键前缀 */
export const CACHE_PREFIX = 'arkli:history:'
/** 请求头：转简体 */
const HEADER_LANG = { 'Accept-Language': 'zh-hans' }
/** 请求头：按 Wikimedia 访问策略标明身份（浏览器里不能改 User-Agent） */
const HEADER_UA = { 'Api-User-Agent': 'arkli/0.1 (https://github.com/icodejoo/arkli)' }

/** 事件关联词条的精简信息 */
export interface HistoryNote {
  /** 词条名 */
  title: string
  /** 一句话描述，可能为空串 */
  desc: string
  /** 简介，已截断，可能为空串 */
  extract: string
}

/** 一条精简后的历史事件 */
export interface HistoryEvent {
  /** 年份，负数为公元前 */
  year: number
  /** 一句话事件说明 */
  text: string
  /** 关联词条；没有可用词条时为 null（界面不可展开） */
  note: HistoryNote | null
}

/** 错误类别 */
export type HistoryErrorKind = 'timeout' | 'rate-limit' | 'http' | 'network' | 'parse'

/** 历史数据获取失败 */
export class HistoryError extends Error {
  /** 错误类别 */
  kind: HistoryErrorKind

  /**
   * @param kind 错误类别
   * @param message 开发用说明
   */
  constructor(kind: HistoryErrorKind, message: string) {
    super(message)
    this.name = 'HistoryError'
    this.kind = kind
  }
}

/** 各类错误对应的友好提示 */
const ERROR_TEXT: Record<HistoryErrorKind, string> = {
  timeout: '请求超时了，网络可能不太好。',
  'rate-limit': '请求太频繁，被对方限流了，过一会儿再试。',
  http: '服务暂时不可用。',
  network: '连不上网，或者请求被拦截了。',
  parse: '返回的数据读不懂。',
}

/** 可注入的依赖 */
export interface HistoryDeps {
  /** fetch 实现，默认用全局 fetch */
  fetchFn?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>
  /** 存储实现，默认 sessionStorage；不可用时自动忽略 */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** 超时毫秒数 */
  timeoutMs?: number
}

/** 内存缓存：月日 -> 精简结果 */
const memory = new Map<string, HistoryEvent[]>()
/** 进行中的请求，同一天并发只发一次 */
const pending = new Map<string, Promise<HistoryEvent[]>>()

/** 清空内存缓存与进行中请求（测试用） */
export function resetHistoryCache(): void {
  memory.clear()
  pending.clear()
}

/**
 * 数字补零到两位。
 *
 * @param n 非负整数
 * @returns 如 3 -> '03'
 */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 缓存键（月日两位补零）。
 *
 * @param month 月
 * @param day 日
 * @returns 如 '02-29'
 */
export function cacheKey(month: number, day: number): string {
  return `${pad2(month)}-${pad2(day)}`
}

/**
 * 构造请求地址。
 *
 * @param month 月 1 到 12
 * @param day 日 1 到 31
 * @returns 完整 URL
 * @example buildUrl(2, 9) // '.../events/02/09'
 */
export function buildUrl(month: number, day: number): string {
  return `${HISTORY_ENDPOINT}/${pad2(month)}/${pad2(day)}`
}

/**
 * 年份显示：公元前的负数规范成「公元前 N 年」。
 *
 * @param year 年份，负数或 0 视为公元前（0 按天文纪年记作公元前 1 年）
 * @returns 如 '1894 年'、'公元前 44 年'
 */
export function formatHistoryYear(year: number): string {
  if (year > 0) return `${year} 年`
  return `公元前 ${year < 0 ? -year : 1} 年`
}

/**
 * 错误类别对应的友好提示。
 *
 * @param kind 错误类别
 * @returns 给用户看的文案
 */
export function historyErrorText(kind: HistoryErrorKind): string {
  return ERROR_TEXT[kind]
}

/**
 * 把任意异常归类。
 *
 * @param e 捕获到的异常
 * @returns 错误类别；已是 HistoryError 则原样返回其类别
 */
export function classifyError(e: unknown): HistoryErrorKind {
  if (e instanceof HistoryError) return e.kind
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError') return 'timeout'
  return 'network'
}

/** 年份词条（如「1894年」「公元前44年」），不当作关联词条 */
const YEAR_TITLE = /^(公元前)?\d+年$/

/**
 * 从事件的关联词条里挑一个可展示的：跳过年份词条，取第一个有简介或描述的。
 *
 * @param pages 原始 pages 数组
 * @returns 精简词条或 null
 */
function pickNote(pages: unknown): HistoryNote | null {
  if (!Array.isArray(pages)) return null
  for (const p of pages) {
    if (!p || typeof p !== 'object') continue
    const o = p as Record<string, unknown>
    const rawTitle = typeof o.normalizedtitle === 'string' ? o.normalizedtitle : typeof o.title === 'string' ? o.title.replace(/_/g, ' ') : ''
    if (!rawTitle || YEAR_TITLE.test(rawTitle)) continue
    const desc = typeof o.description === 'string' ? o.description : ''
    const extract = typeof o.extract === 'string' ? o.extract.slice(0, EXTRACT_MAX) : ''
    if (desc || extract) return { title: rawTitle, desc, extract }
  }
  return null
}

/**
 * 解析并精简接口返回；缺字段的事件丢弃，结果按年份倒序。
 *
 * @param json 接口返回的 JSON
 * @returns 精简事件列表（可能为空数组）
 * @throws HistoryError 结构不是 { events: [] } 时抛 parse
 */
export function parseEvents(json: unknown): HistoryEvent[] {
  const events = (json as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) throw new HistoryError('parse', 'events 不是数组')
  const list: HistoryEvent[] = []
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    if (typeof o.year !== 'number' || typeof o.text !== 'string' || !o.text.trim()) continue
    list.push({ year: o.year, text: o.text.trim(), note: pickNote(o.pages) })
  }
  return list.sort((a, b) => b.year - a.year)
}

/**
 * 读 sessionStorage 缓存；不可用或数据不对都当没有。
 *
 * @param storage 存储对象
 * @param key 缓存键
 * @returns 精简结果或 null
 */
function readStored(storage: HistoryDeps['storage'], key: string): HistoryEvent[] | null {
  try {
    const raw = storage?.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as HistoryEvent[]) : null
  } catch {
    return null
  }
}

/**
 * 写 sessionStorage 缓存；容量不足等错误直接忽略。
 *
 * @param storage 存储对象
 * @param key 缓存键
 * @param list 精简结果
 */
function writeStored(storage: HistoryDeps['storage'], key: string, list: HistoryEvent[]): void {
  try {
    storage?.setItem(CACHE_PREFIX + key, JSON.stringify(list))
  } catch {
    // 容量不足或隐私模式，忽略
  }
}

/**
 * 默认的存储：sessionStorage，访问也可能抛错。
 *
 * @returns 存储对象或 null
 */
function defaultStorage(): HistoryDeps['storage'] {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/**
 * 真正发请求并精简。
 *
 * @param month 月
 * @param day 日
 * @param deps 依赖
 * @returns 精简事件
 * @throws HistoryError
 */
async function requestEvents(month: number, day: number, deps: HistoryDeps): Promise<HistoryEvent[]> {
  const fetchFn = deps.fetchFn ?? ((u, i) => fetch(u, i))
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? HISTORY_TIMEOUT_MS)
  try {
    const res = await fetchFn(buildUrl(month, day), { headers: { ...HEADER_LANG, ...HEADER_UA }, signal: ctrl.signal })
    if (res.status === 429) throw new HistoryError('rate-limit', 'HTTP 429')
    if (!res.ok) throw new HistoryError('http', `HTTP ${res.status}`)
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new HistoryError('parse', 'JSON 解析失败')
    }
    return parseEvents(json)
  } catch (e) {
    throw e instanceof HistoryError ? e : new HistoryError(classifyError(e), String(e))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 取某月日的历史事件：先查内存、再查 sessionStorage，都没有才请求；同一天并发只请求一次。
 *
 * @param month 月 1 到 12
 * @param day 日 1 到 31
 * @param deps 可注入的 fetch / 存储 / 超时
 * @returns 精简事件，按年份倒序
 * @throws HistoryError 请求失败时（失败不缓存）
 * @example const list = await loadHistory(9, 17)
 */
export async function loadHistory(month: number, day: number, deps: HistoryDeps = {}): Promise<HistoryEvent[]> {
  const key = cacheKey(month, day)
  const hit = memory.get(key)
  if (hit) return hit
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage
  const stored = readStored(storage, key)
  if (stored) {
    memory.set(key, stored)
    return stored
  }
  let p = pending.get(key)
  if (!p) {
    p = requestEvents(month, day, deps)
      .then((list) => {
        memory.set(key, list)
        writeStored(storage, key, list)
        return list
      })
      .finally(() => pending.delete(key))
    pending.set(key, p)
  }
  return p
}
