// Cron 表达式：5 段标准写法（分 时 日 月 周）的解析、中文说明与下次触发时间

/** 字段定义：中文名与取值范围 */
export interface FieldDef {
  name: string
  min: number
  max: number
}

/** 五段字段定义，顺序即表达式顺序 */
export const FIELDS: readonly FieldDef[] = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '星期', min: 0, max: 7 },
]

/** 星期中文名，0 与 7 都是周日 */
export const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
/** 查找下次触发时最多向后看多少天（覆盖闰日） */
export const MAX_SEARCH_DAYS = 366 * 9
/** 默认列出触发次数 */
export const DEFAULT_NEXT_COUNT = 5
/** 时分组合不超过该数量时说明里直接列出 HH:MM */
const MAX_LISTED_TIMES = 6

/** 单个字段解析结果 */
export interface ParsedField {
  /** 展开后的取值（升序，星期已把 7 归并为 0） */
  values: number[]
  /** 原文是否以 * 开头（日 / 星期规则用它判断"是否限定"） */
  star: boolean
  /** 原文 */
  raw: string
}

/** 整个表达式 */
export interface CronExpr {
  minute: ParsedField
  hour: ParsedField
  dom: ParsedField
  month: ParsedField
  dow: ParsedField
}

/** 解析结果或错误 */
export type CronParse = { ok: true; expr: CronExpr } | { ok: false; error: string }

/** 解析一个非负整数，非法返回 null */
function toInt(s: string): number | null {
  return /^\d+$/.test(s) ? Number(s) : null
}

/**
 * 解析单个字段。
 * @param raw 字段原文，支持 * , - /
 * @param def 字段定义
 * @returns 解析结果；非法时返回错误原因（不含段名）
 */
function parseField(raw: string, def: FieldDef): ParsedField | string {
  const set = new Set<number>()
  for (const item of raw.split(',')) {
    if (item === '') return '含空的列表项'
    const [rangePart, stepPart, ...extra] = item.split('/')
    if (extra.length) return `"${item}" 的步长写法不对`
    let step = 1
    if (stepPart !== undefined) {
      const s = toInt(stepPart)
      if (s === null || s < 1) return `步长 "${stepPart}" 必须是正整数`
      step = s
    }
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = def.min
      hi = def.max
      // 星期 * 只到 6，避免 0 与 7 重复
      if (def === FIELDS[4]) hi = 6
    } else if (rangePart.includes('-')) {
      const [a, b, ...more] = rangePart.split('-')
      const x = toInt(a)
      const y = toInt(b)
      if (more.length || x === null || y === null) return `"${rangePart}" 不是合法范围`
      if (x > y) return `范围 "${rangePart}" 起点大于终点`
      lo = x
      hi = y
    } else {
      const x = toInt(rangePart)
      if (x === null) return `"${rangePart}" 不是合法数字`
      lo = x
      // a/n 表示从 a 起每 n 个，直到上限
      hi = stepPart !== undefined ? (def === FIELDS[4] ? 6 : def.max) : x
    }
    if (lo < def.min || hi > def.max) return `取值需在 ${def.min}~${def.max} 之间，实际写了 ${lo < def.min ? lo : hi}`
    for (let v = lo; v <= hi; v += step) set.add(def === FIELDS[4] && v === 7 ? 0 : v)
  }
  return { values: [...set].sort((a, b) => a - b), star: raw.startsWith('*'), raw }
}

/**
 * 解析 5 段 cron 表达式。
 * @param text 表达式，如 "*\/5 9-18 * * 1-5"
 * @returns 成功给出展开后的表达式；失败指明哪一段错
 * @example parseCron('0 8 * * 1-5').ok // true
 */
export function parseCron(text: string): CronParse {
  const segs = text.trim().split(/\s+/).filter(Boolean)
  if (segs.length === 0) return { ok: false, error: '请输入 cron 表达式' }
  if (segs.length !== 5) return { ok: false, error: `需要 5 段（分 时 日 月 周），当前是 ${segs.length} 段` }
  const out: ParsedField[] = []
  for (let i = 0; i < 5; i++) {
    const r = parseField(segs[i], FIELDS[i])
    if (typeof r === 'string') return { ok: false, error: `第 ${i + 1} 段（${FIELDS[i].name}）有误：${r}` }
    out.push(r)
  }
  const [minute, hour, dom, month, dow] = out
  return { ok: true, expr: { minute, hour, dom, month, dow } }
}

/** 把升序整数压成"a至b、c"的片段，每个值经 fmt 格式化 */
function joinRuns(values: number[], fmt: (v: number) => string): string {
  const parts: string[] = []
  let i = 0
  while (i < values.length) {
    let j = i
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++
    parts.push(j - i >= 2 ? `${fmt(values[i])}至${fmt(values[j])}` : values.slice(i, j + 1).map(fmt).join('、'))
    i = j + 1
  }
  return parts.join('、')
}

/** 两位补零 */
const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 字段是否取满全部值 */
function isFull(f: ParsedField, def: FieldDef): boolean {
  const max = def === FIELDS[4] ? 6 : def.max
  return f.values.length === max - def.min + 1
}

/** 若字段形如 "*\/n"（整除步长），返回 n，否则 null */
function stepOf(f: ParsedField): number | null {
  const m = /^\*\/(\d+)$/.exec(f.raw)
  return m ? Number(m[1]) : null
}

/** 时间部分说明 */
function describeTime(e: CronExpr): string {
  const { minute, hour } = e
  const minFull = isFull(minute, FIELDS[0])
  const hourFull = isFull(hour, FIELDS[1])
  if (minFull && hourFull) return '每分钟'
  const minStep = stepOf(minute)
  if (hourFull) {
    if (minStep) return `每 ${minStep} 分钟`
    if (minute.values.length === 1) return minute.values[0] === 0 ? '每小时整点' : `每小时的第 ${minute.values[0]} 分钟`
    return `每小时的第 ${joinRuns(minute.values, String)} 分钟`
  }
  const hourStep = stepOf(hour)
  if (minute.values.length === 1 && minute.values[0] === 0 && hourStep) return `每 ${hourStep} 小时整点`
  if (minFull) return `在 ${joinRuns(hour.values, String)} 点的每一分钟`
  if (minute.values.length * hour.values.length <= MAX_LISTED_TIMES) {
    const times: string[] = []
    for (const h of hour.values) for (const m of minute.values) times.push(`${pad2(h)}:${pad2(m)}`)
    return `${times.join('、')}`
  }
  return `在 ${joinRuns(hour.values, String)} 点，每小时的第 ${joinRuns(minute.values, String)} 分钟`
}

/** 日期部分说明（月 / 日 / 星期） */
function describeDate(e: CronExpr): string {
  const monthFull = isFull(e.month, FIELDS[3])
  const domFull = isFull(e.dom, FIELDS[2])
  const dowFull = isFull(e.dow, FIELDS[4])
  const month = monthFull ? '' : `${joinRuns(e.month.values, (v) => `${v}月`)}的`
  const dom = domFull ? '' : `${joinRuns(e.dom.values, (v) => `${v}日`)}`
  const dow = dowFull ? '' : joinRuns(e.dow.values, (v) => WEEK_NAMES[v])
  if (domFull && dowFull) return monthFull ? '每天' : `${month}每天`
  if (domFull) return `${month}每${dow}`
  if (dowFull) return month ? `${month}${dom}` : `每月${dom}`
  // 日与星期都限定：任一满足即触发
  return `${month}${dom}或${dow}`
}

/**
 * 把表达式翻成中文说明。
 * @param e 已解析的表达式
 * @returns 中文说明
 * @example describeCron(expr) // '每天 08:00'
 */
export function describeCron(e: CronExpr): string {
  const date = describeDate(e)
  const time = describeTime(e)
  if (time.startsWith('每')) return date === '每天' ? time : `${date}，${time}`
  return `${date} ${time}`
}

/** 某天是否满足日 / 月 / 星期 */
function dayMatches(e: CronExpr, d: Date): boolean {
  if (!e.month.values.includes(d.getMonth() + 1)) return false
  const domOk = e.dom.values.includes(d.getDate())
  const dowOk = e.dow.values.includes(d.getDay())
  if (e.dom.star || e.dow.star) return domOk && dowOk
  return domOk || dowOk
}

/**
 * 计算之后若干次触发时间（本地时区）。
 * @param e 已解析的表达式
 * @param from 起算时间（不含当前这一分钟）
 * @param count 次数，默认 5
 * @returns 触发时间列表；永远不会触发（如 2 月 30 日）时可能少于 count
 * @example nextRuns(expr, new Date(), 5)
 */
export function nextRuns(e: CronExpr, from: Date, count: number = DEFAULT_NEXT_COUNT): Date[] {
  const out: Date[] = []
  const startMs = Math.floor(from.getTime() / 60000) * 60000 + 60000
  const day = new Date(startMs)
  day.setHours(0, 0, 0, 0)
  for (let n = 0; n < MAX_SEARCH_DAYS && out.length < count; n++) {
    const cur = new Date(day.getFullYear(), day.getMonth(), day.getDate() + n)
    if (!dayMatches(e, cur)) continue
    for (const h of e.hour.values) {
      for (const m of e.minute.values) {
        const t = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), h, m)
        // 夏令时跳过的时刻会被归一，丢弃
        if (t.getHours() !== h || t.getTime() < startMs) continue
        out.push(t)
        if (out.length >= count) return out
      }
    }
  }
  return out
}

/**
 * 触发时间格式化。
 * @param d 时间
 * @returns yyyy-MM-dd 周X HH:mm
 * @example formatRun(new Date())
 */
export function formatRun(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WEEK_NAMES[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
