import { describe, expect, it } from 'vitest'
import {
  dateDiff,
  dayOfYear,
  daysInMonth,
  formatDate,
  fromDayNumber,
  isLeap,
  isValidYMD,
  parseDate,
  shiftDate,
  toDayNumber,
  weekday,
  type YMD,
} from './logic'

/** 简写构造日期 */
const ymd = (y: number, m: number, d: number): YMD => ({ y, m, d })

describe('闰年与月天数', () => {
  it('闰年规则', () => {
    expect(isLeap(2024)).toBe(true)
    expect(isLeap(1900)).toBe(false)
    expect(isLeap(2000)).toBe(true)
    expect(isLeap(2023)).toBe(false)
  })
  it('2 月天数', () => {
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2023, 2)).toBe(28)
    expect(daysInMonth(2023, 12)).toBe(31)
  })
})

describe('日序号', () => {
  it('纪元与往返', () => {
    expect(toDayNumber(ymd(1970, 1, 1))).toBe(0)
    expect(toDayNumber(ymd(1970, 1, 2))).toBe(1)
    expect(toDayNumber(ymd(1969, 12, 31))).toBe(-1)
    expect(toDayNumber(ymd(2000, 3, 1))).toBe(11017)
    expect(fromDayNumber(11017)).toEqual(ymd(2000, 3, 1))
  })
  it('与 Date.UTC 对照', () => {
    for (const x of [ymd(2024, 2, 29), ymd(1999, 12, 31), ymd(1, 1, 1), ymd(9999, 12, 31), ymd(1900, 3, 1)]) {
      const ref = Math.round(Date.UTC(x.y, x.m - 1, x.d) / 86400000)
      // Date.UTC 把 0-99 年当 1900+，只对照 100 年以上
      if (x.y >= 100) expect(toDayNumber(x)).toBe(ref)
      expect(fromDayNumber(toDayNumber(x))).toEqual(x)
    }
  })
})

describe('parseDate / isValidYMD / formatDate', () => {
  it('合法与分隔符', () => {
    expect(parseDate('2024-02-29')).toEqual({ ok: true, value: ymd(2024, 2, 29) })
    expect(parseDate('2024/2/9')).toEqual({ ok: true, value: ymd(2024, 2, 9) })
  })
  it('不存在的日期与格式错误', () => {
    expect(parseDate('2023-02-29')).toMatchObject({ ok: false })
    expect(parseDate('2024-13-01')).toMatchObject({ ok: false })
    expect(parseDate('0000-01-01')).toMatchObject({ ok: false })
    expect(parseDate('')).toMatchObject({ ok: false })
    expect(parseDate('hello')).toMatchObject({ ok: false })
  })
  it('isValidYMD 与格式化', () => {
    expect(isValidYMD(ymd(2024, 4, 31))).toBe(false)
    expect(formatDate(ymd(5, 3, 7))).toBe('0005-03-07')
  })
})

describe('星期与年内第几天', () => {
  it('已知日期', () => {
    expect(weekday(toDayNumber(ymd(1970, 1, 1)))).toBe(4) // 周四
    expect(weekday(toDayNumber(ymd(2024, 2, 29)))).toBe(4) // 周四
    expect(weekday(toDayNumber(ymd(1969, 12, 28)))).toBe(0) // 周日（负序号）
  })
  it('dayOfYear', () => {
    expect(dayOfYear(ymd(2024, 12, 31))).toBe(366)
    expect(dayOfYear(ymd(2023, 3, 1))).toBe(60)
  })
})

describe('shiftDate', () => {
  it('月末溢出取当月最后一天', () => {
    expect(shiftDate(ymd(2024, 1, 31), 1, 'month')).toEqual(ymd(2024, 2, 29))
    expect(shiftDate(ymd(2023, 1, 31), 1, 'month')).toEqual(ymd(2023, 2, 28))
    expect(shiftDate(ymd(2024, 3, 31), -1, 'month')).toEqual(ymd(2024, 2, 29))
  })
  it('闰日加年', () => {
    expect(shiftDate(ymd(2024, 2, 29), 1, 'year')).toEqual(ymd(2025, 2, 28))
    expect(shiftDate(ymd(2024, 2, 29), 4, 'year')).toEqual(ymd(2028, 2, 29))
  })
  it('天与周、跨年、负数', () => {
    expect(shiftDate(ymd(2023, 12, 31), 1, 'day')).toEqual(ymd(2024, 1, 1))
    expect(shiftDate(ymd(2024, 1, 1), -1, 'day')).toEqual(ymd(2023, 12, 31))
    expect(shiftDate(ymd(2024, 1, 1), 2, 'week')).toEqual(ymd(2024, 1, 15))
    expect(shiftDate(ymd(2024, 1, 1), -13, 'month')).toEqual(ymd(2022, 12, 1))
  })
  it('超出支持年份返回 null', () => {
    expect(shiftDate(ymd(9999, 12, 31), 1, 'day')).toBeNull()
    expect(shiftDate(ymd(1, 1, 1), -1, 'month')).toBeNull()
  })
})

describe('dateDiff', () => {
  it('跨闰年', () => {
    expect(dateDiff(ymd(2024, 1, 1), ymd(2025, 1, 1), false)).toEqual({ totalDays: 366, years: 1, months: 0, days: 0 })
  })
  it('月末起算', () => {
    expect(dateDiff(ymd(2024, 1, 31), ymd(2024, 3, 1), false)).toEqual({ totalDays: 30, years: 0, months: 1, days: 1 })
  })
  it('反向给负天数，年月日与方向无关', () => {
    const r = dateDiff(ymd(2024, 3, 1), ymd(2024, 1, 31), false)
    expect(r).toEqual({ totalDays: -30, years: 0, months: 1, days: 1 })
  })
  it('含首尾', () => {
    expect(dateDiff(ymd(2024, 1, 1), ymd(2024, 1, 1), false).totalDays).toBe(0)
    expect(dateDiff(ymd(2024, 1, 1), ymd(2024, 1, 1), true).totalDays).toBe(1)
    expect(dateDiff(ymd(2024, 1, 1), ymd(2024, 1, 10), true).totalDays).toBe(10)
  })
  it('整年整月', () => {
    expect(dateDiff(ymd(2000, 2, 29), ymd(2024, 2, 29), false)).toMatchObject({ years: 24, months: 0, days: 0 })
  })
})
