import { describe, expect, it } from 'vitest'
import { addClock, breakDown, clockDiff, durationUnits, formatDuration, parseHms } from './logic'

describe('parseHms', () => {
  it('时分秒与时分', () => {
    expect(parseHms('01:02:03')).toEqual({ ok: true, seconds: 3723 })
    expect(parseHms('12:30')).toEqual({ ok: true, seconds: 45000 })
    expect(parseHms(' 0:0:0 ')).toEqual({ ok: true, seconds: 0 })
  })
  it('小时可超过 24', () => {
    expect(parseHms('36:00:00')).toEqual({ ok: true, seconds: 129600 })
  })
  it('非法输入', () => {
    expect(parseHms('')).toMatchObject({ ok: false })
    expect(parseHms('12')).toMatchObject({ ok: false })
    expect(parseHms('12:60')).toMatchObject({ ok: false })
    expect(parseHms('12:30:99')).toMatchObject({ ok: false })
    expect(parseHms('a:b')).toMatchObject({ ok: false })
    expect(parseHms('-1:00')).toMatchObject({ ok: false })
  })
})

describe('breakDown / formatDuration', () => {
  it('拆解', () => {
    expect(breakDown(90061)).toEqual({ negative: false, days: 1, hours: 1, minutes: 1, seconds: 1 })
    expect(breakDown(-61)).toEqual({ negative: true, days: 0, hours: 0, minutes: 1, seconds: 1 })
    expect(breakDown(0).seconds).toBe(0)
  })
  it('格式化', () => {
    expect(formatDuration(90061)).toBe('1天 01:01:01')
    expect(formatDuration(59)).toBe('00:00:59')
    expect(formatDuration(-3600)).toBe('-01:00:00')
  })
})

describe('addClock', () => {
  it('加法跨天', () => {
    expect(addClock(23 * 3600, 2 * 3600, 1)).toEqual({ dayOffset: 1, time: '01:00:00' })
  })
  it('减法跨到前一天', () => {
    expect(addClock(3600, 2 * 3600, -1)).toEqual({ dayOffset: -1, time: '23:00:00' })
  })
  it('不跨天', () => {
    expect(addClock(0, 0, 1)).toEqual({ dayOffset: 0, time: '00:00:00' })
    expect(addClock(3600, 1800, 1)).toEqual({ dayOffset: 0, time: '01:30:00' })
  })
  it('时长超过多天', () => {
    expect(addClock(0, 3 * 86400 + 5, 1)).toEqual({ dayOffset: 3, time: '00:00:05' })
  })
})

describe('clockDiff', () => {
  it('同一天', () => {
    expect(clockDiff(3600, 7200, false)).toBe(3600)
  })
  it('b 早于 a：不跨天为负，跨天加 24h', () => {
    expect(clockDiff(82800, 3600, false)).toBe(-79200)
    expect(clockDiff(82800, 3600, true)).toBe(7200)
  })
})

describe('durationUnits', () => {
  it('换算', () => {
    const u = durationUnits(5400)
    expect(u.map((x) => x.value)).toEqual([5400, 90, 1.5, 0.0625])
  })
})
