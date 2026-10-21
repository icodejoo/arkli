// 番茄时钟：阶段状态机与时间计算（纯逻辑）。倒计时一律用绝对时间戳算，不靠 setInterval 累加，后台节流也不会漂移
import { createToolStorage, type StorageLike, type ToolStorage } from '@/shared/toolStorage'

/** 阶段：专注 / 短休 / 长休 */
export type Phase = 'focus' | 'short' | 'long'
/** 计时状态：待开始 / 进行中 / 已暂停 */
export type Status = 'idle' | 'running' | 'paused'

/** 毫秒每分钟 */
export const MS_PER_MIN = 60_000
/** 每多少个专注后进入长休（默认） */
export const DEFAULT_LONG_EVERY = 4
/** 默认专注分钟数 */
export const DEFAULT_FOCUS_MIN = 25
/** 默认短休分钟数 */
export const DEFAULT_SHORT_MIN = 5
/** 默认长休分钟数 */
export const DEFAULT_LONG_MIN = 15
/** 专注时长可调范围（分钟） */
export const FOCUS_RANGE = { min: 1, max: 120 } as const
/** 短休时长可调范围（分钟） */
export const SHORT_RANGE = { min: 1, max: 30 } as const
/** 长休时长可调范围（分钟） */
export const LONG_RANGE = { min: 1, max: 60 } as const
/** 长休间隔可调范围（轮） */
export const EVERY_RANGE = { min: 2, max: 10 } as const
/** 闹钟标识：整个页面只用这一个，重设会覆盖 */
export const ALARM_ID = 'pomodoro'
/** 持久缓存命名空间 */
export const STORE_NS = 'pomodoro'
/** 今日完成数的存储键 */
export const TODAY_KEY = 'today'
/** 设置的存储键 */
export const SETTINGS_KEY = 'settings'
/** 旧版（带 arkli.pomodoro. 前缀）存储键对照：旧完整键 -> 新键 */
export const LEGACY_KEYS: Record<string, string> = {
  'arkli.pomodoro.today': 'today',
  'arkli.pomodoro.settings': 'settings',
  'arkli.pomodoro.state': 'state',
}
/** 保持常亮开关的存储键 */
export const KEEP_ON_KEY = 'keepOn'

/** 时长设置 */
export interface Settings {
  /** 专注分钟数 */
  focusMin: number
  /** 短休分钟数 */
  shortMin: number
  /** 长休分钟数 */
  longMin: number
  /** 每几个专注后长休 */
  longEvery: number
}

/** 计时状态 */
export interface TimerState {
  /** 当前阶段 */
  phase: Phase
  /** 计时状态 */
  status: Status
  /** 当前是第几个专注轮（1 起，长休结束后回到 1） */
  round: number
  /** 进行中时的结束时刻（毫秒时间戳），其余状态为 null */
  endAt: number | null
  /** 待开始 / 已暂停时的剩余毫秒 */
  remainingMs: number
}

/** 推进结果 */
export interface AdvanceResult {
  /** 新状态 */
  state: TimerState
  /** 是否刚完成了一个专注（用来累计今日完成数） */
  focusDone: boolean
  /** 刚结束的阶段 */
  finished: Phase
}

/**
 * 创建番茄钟的持久缓存，并一次性迁移旧键数据。
 *
 * @param backend 存储后端，缺省 localStorage（测试可注入）
 * @returns 持久缓存实例
 */
export function createPomodoroStore(backend?: StorageLike | null): ToolStorage {
  const store = createToolStorage(STORE_NS, backend)
  for (const [legacy, key] of Object.entries(LEGACY_KEYS)) store.adoptLegacy(legacy, key)
  return store
}

/** 默认设置 */
export const DEFAULT_SETTINGS: Settings = {
  focusMin: DEFAULT_FOCUS_MIN,
  shortMin: DEFAULT_SHORT_MIN,
  longMin: DEFAULT_LONG_MIN,
  longEvery: DEFAULT_LONG_EVERY,
}

/** 阶段中文名 */
export const PHASE_LABEL: Record<Phase, string> = { focus: '专注', short: '短休', long: '长休' }

/**
 * 把输入夹到范围内并取整，非数字回退默认值。
 *
 * @param v 输入值
 * @param range 允许范围
 * @param fallback 非数字时的默认值
 * @returns 范围内的整数
 * @example clampInt(500, FOCUS_RANGE, 25) // 120
 */
export function clampInt(v: unknown, range: { min: number; max: number }, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(range.max, Math.max(range.min, Math.round(n)))
}

/**
 * 规范化设置：缺项补默认，越界夹住。
 *
 * @param partial 不完整的设置
 * @returns 完整合法的设置
 * @example normalizeSettings({ focusMin: 999 }).focusMin // 120
 */
export function normalizeSettings(partial: Partial<Settings> | null | undefined): Settings {
  const p = partial ?? {}
  return {
    focusMin: clampInt(p.focusMin, FOCUS_RANGE, DEFAULT_FOCUS_MIN),
    shortMin: clampInt(p.shortMin, SHORT_RANGE, DEFAULT_SHORT_MIN),
    longMin: clampInt(p.longMin, LONG_RANGE, DEFAULT_LONG_MIN),
    longEvery: clampInt(p.longEvery, EVERY_RANGE, DEFAULT_LONG_EVERY),
  }
}

/**
 * 某阶段的总时长。
 *
 * @param s 设置
 * @param phase 阶段
 * @returns 毫秒
 * @example phaseDurationMs(DEFAULT_SETTINGS, 'focus') // 1500000
 */
export function phaseDurationMs(s: Settings, phase: Phase): number {
  const min = phase === 'focus' ? s.focusMin : phase === 'short' ? s.shortMin : s.longMin
  return min * MS_PER_MIN
}

/**
 * 初始状态：第 1 个专注轮，待开始。
 *
 * @param s 设置
 * @returns 初始状态
 */
export function initialState(s: Settings): TimerState {
  return { phase: 'focus', status: 'idle', round: 1, endAt: null, remainingMs: phaseDurationMs(s, 'focus') }
}

/**
 * 开始或继续：以当前剩余时间算出绝对结束时刻。已在进行中则原样返回。
 *
 * @param st 当前状态
 * @param now 当前毫秒时间戳
 * @returns 进行中的新状态
 */
export function start(st: TimerState, now: number): TimerState {
  if (st.status === 'running') return st
  return { ...st, status: 'running', endAt: now + st.remainingMs, remainingMs: st.remainingMs }
}

/**
 * 暂停：把剩余时间固定下来。不在进行中则原样返回。
 *
 * @param st 当前状态
 * @param now 当前毫秒时间戳
 * @returns 暂停后的状态
 */
export function pause(st: TimerState, now: number): TimerState {
  if (st.status !== 'running' || st.endAt === null) return st
  return { ...st, status: 'paused', endAt: null, remainingMs: Math.max(0, st.endAt - now) }
}

/**
 * 重置当前阶段到满时长，待开始（轮次不变）。
 *
 * @param st 当前状态
 * @param s 设置
 * @returns 重置后的状态
 */
export function resetPhase(st: TimerState, s: Settings): TimerState {
  return { ...st, status: 'idle', endAt: null, remainingMs: phaseDurationMs(s, st.phase) }
}

/**
 * 整个重置：回到第 1 轮专注。
 *
 * @param s 设置
 * @returns 初始状态
 */
export function resetAll(s: Settings): TimerState {
  return initialState(s)
}

/**
 * 本循环（直到长休）已完成的专注数：专注阶段是 round-1，休息阶段是 round。
 *
 * @param st 状态
 * @returns 已完成专注数
 */
export function doneRounds(st: TimerState): number {
  return st.phase === 'focus' ? st.round - 1 : st.round
}

/**
 * 当前剩余毫秒（绝对时间戳算出，不累加）。
 *
 * @param st 状态
 * @param now 当前毫秒时间戳
 * @returns 非负毫秒
 */
export function remainingAt(st: TimerState, now: number): number {
  if (st.status === 'running' && st.endAt !== null) return Math.max(0, st.endAt - now)
  return st.remainingMs
}

/**
 * 进行中的阶段是否到点了。
 *
 * @param st 状态
 * @param now 当前毫秒时间戳
 * @returns 到点为 true
 */
export function isFinished(st: TimerState, now: number): boolean {
  return st.status === 'running' && st.endAt !== null && now >= st.endAt
}

/**
 * 紧接着当前阶段的下一阶段：专注满 longEvery 轮后长休，否则短休；休息后回到专注。
 *
 * @param st 状态
 * @param s 设置
 * @returns 下一阶段与轮次
 * @example nextPhaseOf({ ...st, phase: 'focus', round: 4 }, DEFAULT_SETTINGS) // { phase: 'long', round: 4 }
 */
export function nextPhaseOf(st: TimerState, s: Settings): { phase: Phase; round: number } {
  if (st.phase === 'focus') return { phase: st.round % s.longEvery === 0 ? 'long' : 'short', round: st.round }
  return { phase: 'focus', round: st.phase === 'long' ? 1 : st.round + 1 }
}

/**
 * 当前阶段结束后推进到下一阶段（待开始，等用户点开始）。没到点则原样返回 null。
 *
 * @param st 状态
 * @param s 设置
 * @param now 当前毫秒时间戳
 * @returns 推进结果；没到点返回 null
 */
export function advance(st: TimerState, s: Settings, now: number): AdvanceResult | null {
  if (!isFinished(st, now)) return null
  const next = nextPhaseOf(st, s)
  return {
    state: { phase: next.phase, status: 'idle', round: next.round, endAt: null, remainingMs: phaseDurationMs(s, next.phase) },
    focusDone: st.phase === 'focus',
    finished: st.phase,
  }
}

/**
 * 手动跳到下一阶段（不计入完成数）。
 *
 * @param st 状态
 * @param s 设置
 * @returns 下一阶段的待开始状态
 */
export function skip(st: TimerState, s: Settings): TimerState {
  const next = nextPhaseOf(st, s)
  return { phase: next.phase, status: 'idle', round: next.round, endAt: null, remainingMs: phaseDurationMs(s, next.phase) }
}

/**
 * 进度 0~1：已走过的比例。
 *
 * @param st 状态
 * @param s 设置
 * @param now 当前毫秒时间戳
 * @returns 0~1
 */
export function progressOf(st: TimerState, s: Settings, now: number): number {
  const total = phaseDurationMs(s, st.phase)
  return total <= 0 ? 0 : Math.min(1, Math.max(0, 1 - remainingAt(st, now) / total))
}

/**
 * 是否该保持屏幕常亮：开关打开且正在进行中才亮；浮起 / 回来时按它重新申请。
 *
 * @param keepOn 常亮开关
 * @param status 计时状态
 * @returns 该常亮为 true
 * @example wantsAwake(true, 'running') // true
 */
export function wantsAwake(keepOn: boolean, status: Status): boolean {
  return keepOn && status === 'running'
}

/**
 * 毫秒格式化成 `mm:ss`，向上取整到秒（剩 0.3 秒显示 00:01，到点才显示 00:00）。
 *
 * @param ms 毫秒
 * @returns 如 `25:00`、`04:59`；超过 99 分钟照常显示
 * @example formatClock(1500000) // '25:00'
 */
export function formatClock(ms: number): string {
  const sec = Math.ceil(Math.max(0, ms) / 1000)
  const m = Math.floor(sec / 60)
  const r = sec % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/**
 * 结束提醒的通知文案。
 *
 * @param phase 刚结束的阶段
 * @returns 标题与正文
 */
export function alarmCopy(phase: Phase): { title: string; text: string } {
  if (phase === 'focus') return { title: '专注结束', text: '辛苦了，起来活动一下吧。' }
  if (phase === 'short') return { title: '休息结束', text: '回到工作，开始下一轮专注。' }
  return { title: '长休结束', text: '歇够了，开始新的一轮吧。' }
}

/**
 * 本地日期键 `YYYY-MM-DD`。
 *
 * @param now 毫秒时间戳
 * @returns 日期键
 */
export function dayKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 读今日完成数；日期不是今天、数据损坏或存储失败都当 0。
 *
 * @param kv 存储
 * @param now 毫秒时间戳
 * @returns 完成数
 */
export function loadToday(kv: ToolStorage | null, now: number): number {
  try {
    const o = kv?.get<{ day?: string; count?: number } | null>(TODAY_KEY, null)
    if (!o || typeof o !== 'object') return 0
    return o.day === dayKey(now) && typeof o.count === 'number' && o.count >= 0 ? Math.floor(o.count) : 0
  } catch {
    return 0
  }
}

/**
 * 今日完成数加一并写回。
 *
 * @param kv 存储
 * @param now 毫秒时间戳
 * @returns 加一后的数；写失败也返回内存里的新值
 */
export function bumpToday(kv: ToolStorage | null, now: number): number {
  const next = loadToday(kv, now) + 1
  try {
    kv?.set(TODAY_KEY, { day: dayKey(now), count: next })
  } catch {
    // 存储不可用时只在内存里计数
  }
  return next
}

/**
 * 读设置；缺失或损坏用默认值。
 *
 * @param kv 存储
 * @returns 合法设置
 */
export function loadSettings(kv: ToolStorage | null): Settings {
  try {
    return normalizeSettings(kv?.get<Partial<Settings> | null>(SETTINGS_KEY, null))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 写设置，失败静默。
 *
 * @param kv 存储
 * @param s 设置
 */
export function saveSettings(kv: ToolStorage | null, s: Settings): void {
  try {
    kv?.set(SETTINGS_KEY, s)
  } catch {
    // 存储不可用时忽略
  }
}

/** 计时状态的存储键：退出页面后闹钟仍会响，回来时据此恢复 */
export const STATE_KEY = 'state'

/**
 * 读上次保存的计时状态；缺失、损坏或字段不合法返回 null。
 *
 * @param kv 存储
 * @returns 状态或 null
 */
export function loadState(kv: ToolStorage | null): TimerState | null {
  try {
    const o = kv?.get<Partial<TimerState> | null>(STATE_KEY, null)
    if (!o || typeof o !== 'object') return null
    const phaseOk = o.phase === 'focus' || o.phase === 'short' || o.phase === 'long'
    const statusOk = o.status === 'idle' || o.status === 'running' || o.status === 'paused'
    if (!phaseOk || !statusOk) return null
    if (typeof o.round !== 'number' || o.round < 1 || typeof o.remainingMs !== 'number' || o.remainingMs < 0) return null
    if (o.status === 'running' && typeof o.endAt !== 'number') return null
    return { phase: o.phase!, status: o.status!, round: Math.floor(o.round), endAt: o.status === 'running' ? o.endAt! : null, remainingMs: o.remainingMs }
  } catch {
    return null
  }
}

/**
 * 保存计时状态，失败静默。
 *
 * @param kv 存储
 * @param st 状态
 */
export function saveState(kv: ToolStorage | null, st: TimerState): void {
  try {
    kv?.set(STATE_KEY, st)
  } catch {
    // 存储不可用时忽略
  }
}
