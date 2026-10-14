import { describe, expect, it } from 'vitest'
import {
  advance, alarmCopy, doneRounds, bumpToday, clampInt, dayKey, DEFAULT_SETTINGS, formatClock, initialState, isFinished, loadSettings, loadToday,
  MS_PER_MIN, nextPhaseOf, normalizeSettings, pause, phaseDurationMs, progressOf, remainingAt, resetAll, resetPhase, saveSettings, skip,
  loadState, saveState as saveTimerState, start, STATE_KEY, TODAY_KEY, type KV, type TimerState,
} from './logic'

/** 内存版存储 */
function memKV(init: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...init }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

const S = DEFAULT_SETTINGS
const T0 = 1_700_000_000_000

describe('设置', () => {
  it('clampInt：取整、夹范围、非数字回退', () => {
    expect(clampInt(500, { min: 1, max: 120 }, 25)).toBe(120)
    expect(clampInt(0, { min: 1, max: 120 }, 25)).toBe(1)
    expect(clampInt(7.6, { min: 1, max: 120 }, 25)).toBe(8)
    expect(clampInt('abc', { min: 1, max: 120 }, 25)).toBe(25)
    expect(clampInt(NaN, { min: 1, max: 120 }, 25)).toBe(25)
  })
  it('normalizeSettings：缺项补默认，越界夹住', () => {
    expect(normalizeSettings(null)).toEqual(S)
    expect(normalizeSettings({ focusMin: 999, shortMin: 0, longEvery: 1 })).toEqual({ focusMin: 120, shortMin: 1, longMin: 15, longEvery: 2 })
  })
  it('phaseDurationMs', () => {
    expect(phaseDurationMs(S, 'focus')).toBe(25 * MS_PER_MIN)
    expect(phaseDurationMs(S, 'short')).toBe(5 * MS_PER_MIN)
    expect(phaseDurationMs(S, 'long')).toBe(15 * MS_PER_MIN)
  })
})

describe('开始 / 暂停 / 重置', () => {
  it('开始按剩余时间算绝对结束时刻；重复开始不变', () => {
    const st = start(initialState(S), T0)
    expect(st).toMatchObject({ status: 'running', endAt: T0 + 25 * MS_PER_MIN })
    expect(start(st, T0 + 5000)).toBe(st)
  })
  it('剩余时间只看时间戳：任意长的后台冻结也不漂移', () => {
    const st = start(initialState(S), T0)
    expect(remainingAt(st, T0 + 10 * MS_PER_MIN)).toBe(15 * MS_PER_MIN)
    expect(remainingAt(st, T0 + 99 * MS_PER_MIN)).toBe(0)
  })
  it('暂停固定剩余，继续后重算结束时刻', () => {
    const running = start(initialState(S), T0)
    const paused = pause(running, T0 + 60_000)
    expect(paused).toMatchObject({ status: 'paused', endAt: null, remainingMs: 24 * MS_PER_MIN })
    expect(remainingAt(paused, T0 + 999_999)).toBe(24 * MS_PER_MIN)
    const resumed = start(paused, T0 + 600_000)
    expect(resumed.endAt).toBe(T0 + 600_000 + 24 * MS_PER_MIN)
    expect(pause(paused, T0)).toBe(paused)
  })
  it('resetPhase 回到本阶段满时长，resetAll 回到第 1 轮专注', () => {
    const st: TimerState = { phase: 'short', status: 'running', round: 3, endAt: T0 + 1000, remainingMs: 0 }
    expect(resetPhase(st, S)).toEqual({ phase: 'short', status: 'idle', round: 3, endAt: null, remainingMs: 5 * MS_PER_MIN })
    expect(resetAll(S)).toEqual(initialState(S))
  })
})

describe('阶段推进', () => {
  it('专注 -> 短休，第 4 轮 -> 长休，长休后回到第 1 轮', () => {
    expect(nextPhaseOf({ ...initialState(S), round: 1 }, S)).toEqual({ phase: 'short', round: 1 })
    expect(nextPhaseOf({ ...initialState(S), round: 4 }, S)).toEqual({ phase: 'long', round: 4 })
    expect(nextPhaseOf({ ...initialState(S), phase: 'short', round: 2 }, S)).toEqual({ phase: 'focus', round: 3 })
    expect(nextPhaseOf({ ...initialState(S), phase: 'long', round: 4 }, S)).toEqual({ phase: 'focus', round: 1 })
  })
  it('longEvery 可调', () => {
    const s2 = normalizeSettings({ longEvery: 2 })
    expect(nextPhaseOf({ ...initialState(s2), round: 2 }, s2).phase).toBe('long')
  })
  it('没到点不推进，到点后进入下一阶段待开始并标记专注完成', () => {
    const running = start(initialState(S), T0)
    expect(isFinished(running, T0 + 1000)).toBe(false)
    expect(advance(running, S, T0 + 1000)).toBeNull()
    const end = T0 + 25 * MS_PER_MIN
    expect(isFinished(running, end)).toBe(true)
    const r = advance(running, S, end + 5)!
    expect(r.focusDone).toBe(true)
    expect(r.finished).toBe('focus')
    expect(r.state).toEqual({ phase: 'short', status: 'idle', round: 1, endAt: null, remainingMs: 5 * MS_PER_MIN })
  })
  it('休息结束不计入完成数', () => {
    const st = start({ ...initialState(S), phase: 'short', remainingMs: 5 * MS_PER_MIN }, T0)
    const r = advance(st, S, T0 + 5 * MS_PER_MIN)!
    expect(r.focusDone).toBe(false)
    expect(r.state.phase).toBe('focus')
    expect(r.state.round).toBe(2)
  })
  it('skip 直接换阶段', () => {
    expect(skip(initialState(S), S).phase).toBe('short')
  })
})

describe('轮次', () => {
  it('doneRounds：专注中是 round-1，休息中是 round', () => {
    expect(doneRounds({ ...initialState(S), round: 3 })).toBe(2)
    expect(doneRounds({ ...initialState(S), phase: 'short', round: 3 })).toBe(3)
    expect(doneRounds({ ...initialState(S), phase: 'long', round: 4 })).toBe(4)
  })
})

describe('显示', () => {
  it('formatClock 向上取整到秒', () => {
    expect(formatClock(25 * MS_PER_MIN)).toBe('25:00')
    expect(formatClock(4 * MS_PER_MIN + 59_001)).toBe('05:00')
    expect(formatClock(300)).toBe('00:01')
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(-5)).toBe('00:00')
  })
  it('progressOf 0~1', () => {
    const st = start(initialState(S), T0)
    expect(progressOf(st, S, T0)).toBe(0)
    expect(progressOf(st, S, T0 + 12.5 * MS_PER_MIN)).toBeCloseTo(0.5)
    expect(progressOf(st, S, T0 + 99 * MS_PER_MIN)).toBe(1)
  })
  it('alarmCopy 三个阶段都有文案', () => {
    for (const p of ['focus', 'short', 'long'] as const) {
      const c = alarmCopy(p)
      expect(c.title).not.toBe('')
      expect(c.text).not.toBe('')
    }
  })
})

describe('今日完成数与设置存储', () => {
  it('同一天累加，跨天归零', () => {
    const kv = memKV()
    expect(loadToday(kv, T0)).toBe(0)
    expect(bumpToday(kv, T0)).toBe(1)
    expect(bumpToday(kv, T0 + 1000)).toBe(2)
    expect(loadToday(kv, T0)).toBe(2)
    expect(loadToday(kv, T0 + 3 * 86_400_000)).toBe(0)
    expect(bumpToday(kv, T0 + 3 * 86_400_000)).toBe(1)
  })
  it('数据损坏或存储缺失按 0 处理，写失败仍返回新值', () => {
    expect(loadToday(memKV({ [TODAY_KEY]: '{bad' }), T0)).toBe(0)
    expect(loadToday(memKV({ [TODAY_KEY]: JSON.stringify({ day: dayKey(T0), count: -3 }) }), T0)).toBe(0)
    expect(loadToday(null, T0)).toBe(0)
    const broken: KV = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(bumpToday(broken, T0)).toBe(1)
    expect(bumpToday(null, T0)).toBe(1)
  })
  it('设置存取往返；损坏回默认', () => {
    const kv = memKV()
    saveSettings(kv, { focusMin: 30, shortMin: 6, longMin: 20, longEvery: 3 })
    expect(loadSettings(kv)).toEqual({ focusMin: 30, shortMin: 6, longMin: 20, longEvery: 3 })
    expect(loadSettings(memKV({ 'arkli.pomodoro.settings': 'xx' }))).toEqual(S)
    expect(loadSettings(null)).toEqual(S)
  })
})

describe('计时状态存取', () => {
  it('往返一致；进行中的保留结束时刻', () => {
    const kv = memKV()
    const st = start(initialState(S), T0)
    saveTimerState(kv, st)
    expect(loadState(kv)).toEqual(st)
    const paused = pause(st, T0 + 1000)
    saveTimerState(kv, paused)
    expect(loadState(kv)).toEqual(paused)
  })
  it('损坏或不合法返回 null', () => {
    expect(loadState(null)).toBeNull()
    expect(loadState(memKV())).toBeNull()
    expect(loadState(memKV({ [STATE_KEY]: '{bad' }))).toBeNull()
    expect(loadState(memKV({ [STATE_KEY]: JSON.stringify({ phase: 'x', status: 'idle', round: 1, remainingMs: 1 }) }))).toBeNull()
    expect(loadState(memKV({ [STATE_KEY]: JSON.stringify({ phase: 'focus', status: 'running', round: 1, remainingMs: 1 }) }))).toBeNull()
    expect(loadState(memKV({ [STATE_KEY]: JSON.stringify({ phase: 'focus', status: 'idle', round: 0, remainingMs: 1 }) }))).toBeNull()
  })
  it('写失败不抛', () => {
    const broken: KV = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => saveTimerState(broken, initialState(S))).not.toThrow()
    expect(() => saveTimerState(null, initialState(S))).not.toThrow()
  })
})
