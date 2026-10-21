// 通知自己：提醒时间的解析、校验与展示（纯逻辑）

/** 毫秒每分钟 */
export const MS_PER_MIN = 60_000
/** 毫秒每天 */
export const MS_PER_DAY = 86_400_000
/** 闹钟最远能设多久之后（366 天，与原生一致） */
export const MAX_AHEAD_MS = 366 * MS_PER_DAY
/** 「N 分钟后」的分钟数上限 */
export const MAX_DELAY_MIN = 366 * 24 * 60
/** 标题长度上限 */
export const MAX_TITLE = 100
/** 正文长度上限 */
export const MAX_TEXT = 500
/** 提醒方式：立即 / 几分钟后 / 指定时间 */
export type Mode = 'now' | 'delay' | 'at'
/** 持久缓存命名空间 */
export const STORE_NS = 'notify-self'
/** 可选提醒方式值 */
export const MODE_VALUES: readonly Mode[] = ['now', 'delay', 'at']
/** 闹钟标识前缀 */
export const ID_PREFIX = 'note-'
/** 常用「几分钟后」快捷项 */
export const DELAY_PRESETS = [5, 10, 30, 60] as const

/** 表单输入 */
export interface FormInput {
  /** 提醒方式 */
  mode: Mode
  /** 标题 */
  title: string
  /** 正文 */
  text: string
  /** 「N 分钟后」的分钟数（文本框原样输入） */
  delayMin: string | number
  /** 指定时间，`datetime-local` 的值，形如 `2026-10-13T19:30` */
  atText: string
}

/** 校验通过的提醒请求 */
export interface ReminderPlan {
  /** 立即发还是设闹钟 */
  kind: 'now' | 'alarm'
  /** 标题（已去空白） */
  title: string
  /** 正文（已去空白，可为空串） */
  text: string
  /** 触发时刻（毫秒时间戳），立即发时为 null */
  atEpochMs: number | null
}

/** 校验结果：成功带 plan，失败带 error */
export type PlanResult = { ok: true; plan: ReminderPlan } | { ok: false; error: string }

/**
 * 解析 `datetime-local` 的值为本地时间的毫秒时间戳。
 *
 * @param text 形如 `2026-10-13T19:30` 或 `2026-10-13T19:30:15`
 * @returns 时间戳；格式不对或日期不存在（如 2 月 30 日）返回 null
 * @example parseLocalDateTime('2026-10-13T19:30') // 本地 19:30 的时间戳
 */
export function parseLocalDateTime(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  if (!m) return null
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)]
  const date = new Date(y, mo - 1, d, h, mi, s, 0)
  // 日期溢出（如 2 月 30 日）会被 Date 悄悄进位，核对一遍
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) return null
  return date.getTime()
}

/**
 * 毫秒时间戳格式化成 `datetime-local` 的值（本地时间，精确到分）。
 *
 * @param ms 时间戳
 * @returns 形如 `2026-10-13T19:30`
 */
export function toLocalDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 解析「N 分钟后」的分钟数：正整数，不超过一年。
 *
 * @param v 输入（文本或数字）
 * @returns 分钟数；不合法返回 null
 * @example parseDelayMin('30') // 30
 */
export function parseDelayMin(v: string | number): number | null {
  const s = String(v).trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= MAX_DELAY_MIN ? n : null
}

/**
 * 校验触发时刻：必须在未来，且不超过一年。
 *
 * @param at 时间戳
 * @param now 当前时间戳
 * @returns 错误说明；合法为 null
 */
export function checkAlarmTime(at: number, now: number): string | null {
  if (at <= now) return '这个时间已经过去了'
  if (at > now + MAX_AHEAD_MS) return '最多只能提前设一年'
  return null
}

/**
 * 把表单输入变成提醒请求，同时做全部校验。
 *
 * @param input 表单输入
 * @param now 当前时间戳
 * @returns 成功带请求，失败带中文提示
 * @example buildPlan({ mode: 'delay', title: '喝水', text: '', delayMin: '10', atText: '' }, Date.now())
 */
export function buildPlan(input: FormInput, now: number): PlanResult {
  const title = input.title.trim()
  const text = input.text.trim()
  if (!title) return { ok: false, error: '先写个标题' }
  if (title.length > MAX_TITLE) return { ok: false, error: `标题最多 ${MAX_TITLE} 字` }
  if (text.length > MAX_TEXT) return { ok: false, error: `内容最多 ${MAX_TEXT} 字` }
  if (input.mode === 'now') return { ok: true, plan: { kind: 'now', title, text, atEpochMs: null } }
  let at: number
  if (input.mode === 'delay') {
    const min = parseDelayMin(input.delayMin)
    if (min === null) return { ok: false, error: `分钟数需要是 1~${MAX_DELAY_MIN} 的整数` }
    at = now + min * MS_PER_MIN
  } else {
    const parsed = parseLocalDateTime(input.atText)
    if (parsed === null) return { ok: false, error: '请选择一个有效的时间' }
    // 选择器精确到分，去掉毫秒零头后与当前比较
    at = parsed
  }
  const err = checkAlarmTime(at, now)
  if (err) return { ok: false, error: err }
  return { ok: true, plan: { kind: 'alarm', title, text, atEpochMs: at } }
}

/**
 * 生成闹钟标识：前缀 + 时间 + 随机数，同一毫秒也不撞。
 *
 * @param now 当前时间戳
 * @param rand 随机数函数，缺省 Math.random（测试注入）
 * @returns 标识，长度远小于 64
 */
export function makeAlarmId(now: number, rand: () => number = Math.random): string {
  return `${ID_PREFIX}${now.toString(36)}-${Math.floor(rand() * 36 ** 4).toString(36)}`
}

/**
 * 是不是本页创建的闹钟（用来过滤番茄时钟等其它页面的闹钟）。
 *
 * @param id 闹钟标识
 * @returns 是为 true
 */
export function isOwnAlarm(id: string): boolean {
  return id.startsWith(ID_PREFIX)
}

/**
 * 距离触发还有多久，中文口语。
 *
 * @param ms 毫秒
 * @returns 如 `不到 1 分钟`、`35 分钟`、`2 小时 5 分钟`、`3 天 2 小时`
 */
export function formatCountdown(ms: number): string {
  if (ms < MS_PER_MIN) return '不到 1 分钟'
  const totalMin = Math.floor(ms / MS_PER_MIN)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`
  return `${mins} 分钟`
}

/**
 * 触发时刻的展示：今天 / 明天用中文，其它用月日。
 *
 * @param at 触发时间戳
 * @param now 当前时间戳
 * @returns 如 `今天 19:30`、`明天 08:00`、`10月20日 09:15`
 */
export function formatAt(at: number, now: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const dayStart = (t: number): number => {
    const x = new Date(t)
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  }
  const diffDays = Math.round((dayStart(at) - dayStart(now)) / MS_PER_DAY)
  if (diffDays === 0) return `今天 ${hm}`
  if (diffDays === 1) return `明天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}
