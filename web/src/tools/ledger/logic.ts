// 记账纯逻辑：金额解析（整数分）、按月统计、分类占比、CSV/JSON 导出与导入校验。时间一律按本地时区。

/** 收支方向：in 收入，out 支出 */
export type Kind = 'in' | 'out'

/** 一条账目 */
export interface Entry {
  /** 主键，按创建时间大致有序 */
  id: string
  /** 金额，整数分，恒为正，方向看 kind */
  amountCents: number
  /** 收入或支出 */
  kind: Kind
  /** 分类名 */
  category: string
  /** 备注 */
  note: string
  /** 发生时间（毫秒时间戳） */
  ts: number
}

/** 月度合计 */
export interface Summary {
  /** 收入合计（分） */
  income: number
  /** 支出合计（分） */
  expense: number
  /** 结余（分，可为负） */
  balance: number
}

/** 分类占比一项 */
export interface CategoryShare {
  /** 分类名 */
  category: string
  /** 该分类合计（分） */
  cents: number
  /** 占该方向总额的百分比（0~100，保留 1 位小数） */
  percent: number
}

/** 导入结果 */
export interface ImportResult {
  /** 通过校验的账目 */
  entries: Entry[]
  /** 备份里带的分类（没有则为 undefined） */
  categories?: Record<Kind, string[]>
  /** 被丢弃的无效条目数 */
  skipped: number
}

/** 金额上限（分），约 9.99 亿元，防止超出安全整数或界面溢出 */
export const MAX_CENTS = 99999999999
/** 每元的分数 */
export const CENTS_PER_YUAN = 100
/** 分类名最大长度 */
export const MAX_CATEGORY_LEN = 8
/** 每个方向最多的分类数 */
export const MAX_CATEGORIES = 30
/** 备注最大长度 */
export const MAX_NOTE_LEN = 100
/** 备份文件里的 app 标识 */
export const BACKUP_APP = 'arkli'
/** 备份结构版本 */
export const BACKUP_SCHEMA = 1
/** CSV 文件开头的 UTF-8 BOM，Excel 靠它识别中文 */
export const CSV_BOM = '﻿'
/** CSV 表头 */
export const CSV_HEADER = ['日期', '类型', '分类', '金额', '备注']
/** 触发备份提醒的记录数 */
export const REMIND_COUNT = 50
/** 触发备份提醒的间隔（天） */
export const REMIND_DAYS = 30
/** 一天的毫秒数 */
const DAY_MS = 86400000
/** 方向的中文名 */
export const KIND_LABEL: Record<Kind, string> = { in: '收入', out: '支出' }

/** 默认分类 */
export const DEFAULT_CATEGORIES: Record<Kind, string[]> = {
  out: ['餐饮', '交通', '购物', '日用', '住房', '娱乐', '医疗', '学习', '人情', '其他'],
  in: ['工资', '奖金', '理财', '红包', '兼职', '其他'],
}

/** 金额文本：整数或小数，小数最多两位；允许省略整数部分或小数部分 */
const AMOUNT_RE = /^(\d*)(?:\.(\d{0,2}))?$/

/**
 * 把用户输入的金额（元）解析成整数分。负数、零、多于两位小数、超过上限都返回 null。
 * 允许千分位逗号，如 "1,234.5"。
 *
 * @param text 输入文本
 * @returns 整数分；不合法返回 null
 * @example parseAmountToCents('12.3') // 1230
 * @example parseAmountToCents('0.05') // 5
 * @example parseAmountToCents('-3') // null
 */
export function parseAmountToCents(text: string): number | null {
  const t = text.trim().replace(/,/g, '')
  if (!t || t === '.') return null
  const m = AMOUNT_RE.exec(t)
  if (!m) return null
  const yuan = m[1] || '0'
  // 整数部分过长直接拒绝，避免精度丢失
  if (yuan.length > 10) return null
  const frac = (m[2] ?? '').padEnd(2, '0')
  const cents = Number(yuan) * CENTS_PER_YUAN + Number(frac)
  if (cents <= 0 || cents > MAX_CENTS) return null
  return cents
}

/**
 * 整数分格式化成 "12.30"（不带符号与单位）。
 *
 * @param cents 整数分，可为负
 * @returns 两位小数的字符串
 * @example formatCents(1230) // '12.30'
 * @example formatCents(-5) // '-0.05'
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const a = Math.abs(Math.round(cents))
  return `${sign}${Math.floor(a / CENTS_PER_YUAN)}.${String(a % CENTS_PER_YUAN).padStart(2, '0')}`
}

/**
 * 补零到两位。
 *
 * @param n 数字
 */
function p2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 时间戳转月份键 "YYYY-MM"（本地时区）。
 *
 * @param ts 毫秒时间戳
 * @returns 月份键
 * @example monthKey(new Date(2026, 0, 31).getTime()) // '2026-01'
 */
export function monthKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`
}

/**
 * 月份键换算成起止时间戳：[start, end)，左闭右开，跨月边界不重叠。
 *
 * @param key 月份键 "YYYY-MM"
 * @returns 起止时间戳；格式不对返回 null
 * @example monthRange('2026-02') // { start: 2026-02-01 00:00, end: 2026-03-01 00:00 }
 */
export function monthRange(key: string): { start: number; end: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return null
  const y = Number(m[1])
  const mon = Number(m[2])
  if (mon < 1 || mon > 12) return null
  return { start: new Date(y, mon - 1, 1).getTime(), end: new Date(y, mon, 1).getTime() }
}

/**
 * 月份键前后偏移若干月。
 *
 * @param key 月份键
 * @param delta 偏移月数（可负）
 * @returns 新月份键；key 非法时原样返回
 * @example shiftMonth('2026-01', -1) // '2025-12'
 */
export function shiftMonth(key: string, delta: number): string {
  const r = monthRange(key)
  if (!r) return key
  const d = new Date(r.start)
  return monthKey(new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime())
}

/**
 * 筛出某月的账目，按时间倒序（同刻按 id 倒序）。
 *
 * @param entries 全部账目
 * @param key 月份键
 * @returns 该月账目；key 非法返回空数组
 */
export function filterMonth(entries: Entry[], key: string): Entry[] {
  const r = monthRange(key)
  if (!r) return []
  return entries
    .filter((e) => e.ts >= r.start && e.ts < r.end)
    .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/**
 * 汇总收入、支出与结余。
 *
 * @param entries 账目
 * @returns 合计
 * @example summarize([{ kind: 'in', amountCents: 500 }, { kind: 'out', amountCents: 200 }]).balance // 300
 */
export function summarize(entries: Pick<Entry, 'kind' | 'amountCents'>[]): Summary {
  let income = 0
  let expense = 0
  for (const e of entries) {
    if (e.kind === 'in') income += e.amountCents
    else expense += e.amountCents
  }
  return { income, expense, balance: income - expense }
}

/**
 * 某方向的分类占比，按金额从大到小；金额相同按分类名排序保证稳定。
 *
 * @param entries 账目
 * @param kind 方向
 * @returns 分类占比列表；该方向无账目返回空数组
 * @example categoryShares(entries, 'out')[0] // { category: '餐饮', cents: 8000, percent: 80 }
 */
export function categoryShares(entries: Entry[], kind: Kind): CategoryShare[] {
  const sums = new Map<string, number>()
  let total = 0
  for (const e of entries) {
    if (e.kind !== kind) continue
    sums.set(e.category, (sums.get(e.category) ?? 0) + e.amountCents)
    total += e.amountCents
  }
  if (!total) return []
  return [...sums.entries()]
    .map(([category, cents]) => ({ category, cents, percent: Math.round((cents / total) * 1000) / 10 }))
    .sort((a, b) => b.cents - a.cents || (a.category < b.category ? -1 : 1))
}

/**
 * 生成账目 id：时间戳（36 进制补齐）+ 随机后缀，大致按创建时间有序。
 *
 * @param now 当前毫秒时间戳
 * @param rand 随机数函数，默认 Math.random（测试可注入）
 * @returns id
 */
export function newId(now: number = Date.now(), rand: () => number = Math.random): string {
  return `${now.toString(36).padStart(9, '0')}${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')}`
}

/**
 * 时间戳转 "YYYY-MM-DD"（本地时区）。
 *
 * @param ts 毫秒时间戳
 * @returns 日期字符串
 */
export function tsToDateStr(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/**
 * "YYYY-MM-DD" 转当天本地中午 12:00 的时间戳（避开午夜与夏令时边界）。
 *
 * @param s 日期字符串
 * @returns 时间戳；日期不存在（如 2 月 30 日）返回 null
 * @example dateStrToTs('2026-02-30') // null
 */
export function dateStrToTs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mon = Number(m[2])
  const day = Number(m[3])
  const d = new Date(y, mon - 1, day, 12)
  if (d.getFullYear() !== y || d.getMonth() !== mon - 1 || d.getDate() !== day) return null
  return d.getTime()
}

/**
 * 校验并规整分类名：去首尾空白，非空，不超过长度上限。
 *
 * @param name 输入
 * @returns 规整后的名字；不合法返回 null
 */
export function normalizeCategory(name: string): string | null {
  const t = name.trim()
  return t && t.length <= MAX_CATEGORY_LEN ? t : null
}

/**
 * 往分类列表追加一个，重名、非法或超上限则原样返回。
 *
 * @param list 现有分类
 * @param name 新分类名
 * @returns 新列表（不改原数组）
 * @example addCategory(['餐饮'], '宠物') // ['餐饮', '宠物']
 */
export function addCategory(list: string[], name: string): string[] {
  const n = normalizeCategory(name)
  if (!n || list.includes(n) || list.length >= MAX_CATEGORIES) return list
  return [...list, n]
}

/**
 * 删除一个分类，至少保留一个。已有账目里的该分类名不受影响。
 *
 * @param list 现有分类
 * @param name 要删的分类
 * @returns 新列表
 */
export function removeCategory(list: string[], name: string): string[] {
  if (list.length <= 1) return list
  return list.filter((c) => c !== name)
}

/**
 * CSV 单元格转义：以公式字符开头的文本前加单引号防 Excel 公式注入；含逗号、引号、换行时加引号包裹。
 *
 * @param v 单元格文本
 * @returns 转义后的文本
 * @example csvCell('a,b') // '"a,b"'
 * @example csvCell('=1+1') // "'=1+1"
 */
export function csvCell(v: string): string {
  let s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * 导出 CSV：带 UTF-8 BOM，行尾 CRLF，按时间正序。
 *
 * @param entries 账目
 * @returns CSV 文本
 * @example toCsv([]).startsWith('﻿日期,类型,分类,金额,备注') // true
 */
export function toCsv(entries: Entry[]): string {
  const rows = [...entries]
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    .map((e) =>
      [tsToDateStr(e.ts), KIND_LABEL[e.kind], e.category, formatCents(e.amountCents), e.note].map(csvCell).join(','),
    )
  return CSV_BOM + [CSV_HEADER.join(','), ...rows].join('\r\n') + '\r\n'
}

/**
 * 导出 JSON 备份（结构对齐 docs 里的 backup 约定，ledger 下放账目与分类）。
 *
 * @param entries 账目
 * @param categories 分类
 * @param now 导出时间，默认当前
 * @returns JSON 文本
 */
export function toBackupJson(entries: Entry[], categories: Record<Kind, string[]>, now: number = Date.now()): string {
  return JSON.stringify(
    { app: BACKUP_APP, schema: BACKUP_SCHEMA, exportedAt: now, tools: { ledger: { entries, categories } } },
    null,
    2,
  )
}

/**
 * 判断是否为合法账目。
 *
 * @param v 任意值
 * @returns 类型守卫
 */
export function isEntry(v: unknown): v is Entry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    Number.isSafeInteger(e.amountCents) &&
    (e.amountCents as number) > 0 &&
    (e.amountCents as number) <= MAX_CENTS &&
    (e.kind === 'in' || e.kind === 'out') &&
    typeof e.category === 'string' &&
    e.category.length > 0 &&
    typeof e.note === 'string' &&
    typeof e.ts === 'number' &&
    Number.isFinite(e.ts)
  )
}

/**
 * 从未知值里挑出合法的分类列表（字符串、规整、去重、截断）。
 *
 * @param v 任意值
 * @returns 分类列表；不是数组返回空数组
 */
function cleanCategories(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  let out: string[] = []
  for (const c of v) if (typeof c === 'string') out = addCategory(out, c)
  return out
}

/**
 * 解析导入文本：接受备份对象，或直接一个账目数组。无效条目计入 skipped，不中断。
 *
 * @param text JSON 文本
 * @returns 解析结果
 * @throws 不是合法 JSON、或找不到账目数组时抛出带中文原因的 Error
 * @example parseImport(toBackupJson(entries, DEFAULT_CATEGORIES)).entries.length
 */
export function parseImport(text: string): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error('文件不是有效的 JSON')
  }
  let raw: unknown
  let cats: unknown
  if (Array.isArray(data)) {
    raw = data
  } else if (data && typeof data === 'object') {
    const ledger = (data as { tools?: { ledger?: unknown } }).tools?.ledger
    if (Array.isArray(ledger)) {
      raw = ledger
    } else if (ledger && typeof ledger === 'object') {
      raw = (ledger as { entries?: unknown }).entries
      cats = (ledger as { categories?: unknown }).categories
    }
  }
  if (!Array.isArray(raw)) throw new Error('没有找到记账数据')
  const entries = raw.filter(isEntry).map((e) => ({
    id: e.id,
    amountCents: e.amountCents,
    kind: e.kind,
    category: e.category,
    note: e.note.slice(0, MAX_NOTE_LEN),
    ts: e.ts,
  }))
  let categories: Record<Kind, string[]> | undefined
  if (cats && typeof cats === 'object') {
    const c = cats as Record<string, unknown>
    const out = cleanCategories(c.out)
    const inn = cleanCategories(c.in)
    if (out.length && inn.length) categories = { out, in: inn }
  }
  return { entries, categories, skipped: raw.length - entries.length }
}

/**
 * 合并导入的账目：id 已存在的保留本地，不覆盖。
 *
 * @param existing 本地账目
 * @param incoming 导入账目
 * @returns 需要新增的账目
 */
export function pickNewEntries(existing: Entry[], incoming: Entry[]): Entry[] {
  const ids = new Set(existing.map((e) => e.id))
  const out: Entry[] = []
  for (const e of incoming) {
    if (ids.has(e.id)) continue
    ids.add(e.id)
    out.push(e)
  }
  return out
}

/**
 * 是否该提示用户备份：有数据，且（从没导出过且记录满 50 条，或距上次导出超过 30 天）。
 *
 * @param count 记录数
 * @param lastExport 上次导出时间戳，没有则 undefined
 * @param now 当前时间戳
 * @returns 是否提示
 */
export function shouldRemindBackup(count: number, lastExport: number | undefined, now: number): boolean {
  if (count <= 0) return false
  if (lastExport === undefined) return count >= REMIND_COUNT
  return now - lastExport > REMIND_DAYS * DAY_MS
}
