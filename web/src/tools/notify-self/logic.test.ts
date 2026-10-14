import { describe, expect, it } from 'vitest'
import {
  buildPlan, checkAlarmTime, formatAt, formatCountdown, ID_PREFIX, isOwnAlarm, makeAlarmId, MAX_AHEAD_MS, MAX_DELAY_MIN, MS_PER_DAY,
  MS_PER_MIN, parseDelayMin, parseLocalDateTime, toLocalDateTime, type FormInput,
} from './logic'

/** 固定的“现在”：本地 2026-10-13 12:00 */
const NOW = new Date(2026, 9, 13, 12, 0, 0, 0).getTime()

/** 造表单输入，缺项给默认 */
function form(p: Partial<FormInput>): FormInput {
  return { mode: 'delay', title: '喝水', text: '', delayMin: '10', atText: '', ...p }
}

describe('parseLocalDateTime / toLocalDateTime', () => {
  it('解析本地时间并可往返', () => {
    const t = parseLocalDateTime('2026-10-13T19:30')!
    expect(new Date(t).getHours()).toBe(19)
    expect(toLocalDateTime(t)).toBe('2026-10-13T19:30')
    expect(parseLocalDateTime('2026-10-13 19:30:15')).toBe(t + 15_000)
  })
  it('格式不对或日期不存在返回 null', () => {
    for (const bad of ['', 'abc', '2026-10-13', '2026-02-30T10:00', '2026-13-01T10:00', '2026-10-13T25:00', '2026-10-13T10:61']) {
      expect(parseLocalDateTime(bad), bad).toBeNull()
    }
  })
})

describe('parseDelayMin', () => {
  it('正整数且不超过一年', () => {
    expect(parseDelayMin('30')).toBe(30)
    expect(parseDelayMin(5)).toBe(5)
    expect(parseDelayMin(' 7 ')).toBe(7)
    expect(parseDelayMin(String(MAX_DELAY_MIN))).toBe(MAX_DELAY_MIN)
  })
  it('小数、负数、零、超限、空都不行', () => {
    for (const bad of ['', '0', '-3', '1.5', 'abc', String(MAX_DELAY_MIN + 1), '1e3']) expect(parseDelayMin(bad), bad).toBeNull()
  })
})

describe('checkAlarmTime', () => {
  it('必须在未来且不超过一年', () => {
    expect(checkAlarmTime(NOW + 1, NOW)).toBeNull()
    expect(checkAlarmTime(NOW, NOW)).toMatch(/过去/)
    expect(checkAlarmTime(NOW - 1000, NOW)).toMatch(/过去/)
    expect(checkAlarmTime(NOW + MAX_AHEAD_MS, NOW)).toBeNull()
    expect(checkAlarmTime(NOW + MAX_AHEAD_MS + 1, NOW)).toMatch(/一年/)
  })
})

describe('buildPlan', () => {
  it('立即：不需要时间', () => {
    expect(buildPlan(form({ mode: 'now', title: ' 开会 ', text: ' 三楼 ' }), NOW)).toEqual({
      ok: true,
      plan: { kind: 'now', title: '开会', text: '三楼', atEpochMs: null },
    })
  })
  it('N 分钟后：按当前时间加', () => {
    expect(buildPlan(form({ delayMin: '25' }), NOW)).toEqual({ ok: true, plan: { kind: 'alarm', title: '喝水', text: '', atEpochMs: NOW + 25 * MS_PER_MIN } })
  })
  it('指定时间：解析本地时间', () => {
    const r = buildPlan(form({ mode: 'at', atText: '2026-10-13T19:30' }), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(toLocalDateTime(r.plan.atEpochMs!)).toBe('2026-10-13T19:30')
  })
  it('各种错误给出中文提示', () => {
    const msg = (p: Partial<FormInput>): string => {
      const r = buildPlan(form(p), NOW)
      return r.ok ? '' : r.error
    }
    expect(msg({ title: '  ' })).toMatch(/标题/)
    expect(msg({ title: 'a'.repeat(101) })).toMatch(/标题最多/)
    expect(msg({ text: 'a'.repeat(501) })).toMatch(/内容最多/)
    expect(msg({ delayMin: '0' })).toMatch(/分钟数/)
    expect(msg({ mode: 'at', atText: '' })).toMatch(/有效的时间/)
    expect(msg({ mode: 'at', atText: '2026-10-13T11:00' })).toMatch(/过去/)
    expect(msg({ mode: 'at', atText: '2028-10-13T11:00' })).toMatch(/一年/)
  })
})

describe('闹钟标识', () => {
  it('带前缀、长度合规、随机部分不同则不同', () => {
    const a = makeAlarmId(NOW, () => 0.1)
    const b = makeAlarmId(NOW, () => 0.9)
    expect(a.startsWith(ID_PREFIX)).toBe(true)
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(isOwnAlarm(a)).toBe(true)
    expect(isOwnAlarm('pomodoro')).toBe(false)
  })
})

describe('展示', () => {
  it('formatCountdown', () => {
    expect(formatCountdown(30_000)).toBe('不到 1 分钟')
    expect(formatCountdown(35 * MS_PER_MIN)).toBe('35 分钟')
    expect(formatCountdown(125 * MS_PER_MIN)).toBe('2 小时 5 分钟')
    expect(formatCountdown(120 * MS_PER_MIN)).toBe('2 小时')
    expect(formatCountdown(3 * MS_PER_DAY + 2 * 60 * MS_PER_MIN)).toBe('3 天 2 小时')
    expect(formatCountdown(2 * MS_PER_DAY)).toBe('2 天')
  })
  it('formatAt：今天 / 明天 / 月日', () => {
    expect(formatAt(new Date(2026, 9, 13, 19, 30).getTime(), NOW)).toBe('今天 19:30')
    expect(formatAt(new Date(2026, 9, 14, 8, 0).getTime(), NOW)).toBe('明天 08:00')
    expect(formatAt(new Date(2026, 9, 20, 9, 15).getTime(), NOW)).toBe('10月20日 09:15')
  })
})
