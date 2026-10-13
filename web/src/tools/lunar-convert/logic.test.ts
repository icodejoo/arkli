import { describe, expect, it } from 'vitest'
import {
  MAX_YEAR,
  MIN_YEAR,
  formatLunar,
  formatSolar,
  lunarDayCount,
  lunarDayOptions,
  lunarMonthOptions,
  lunarToSolar,
  YEAR_WINDOW,
  solarDayOptions,
  solarMonthOptions,
  yearOptions,
  parseLunar,
  parseSolar,
  solarToLunar,
  todaySolar,
  type LunarInfo,
  type SolarDate,
} from './logic'

/** 取阳历转阴历的成功值，失败直接抛错让用例红 */
function toLunar(year: number, month: number, day: number): LunarInfo {
  const r = solarToLunar({ year, month, day })
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('阳历转阴历（已知日期）', () => {
  it('2024-02-10 = 甲辰年正月初一，属龙，星期六', () => {
    const i = toLunar(2024, 2, 10)
    expect(i.date).toEqual({ year: 2024, month: 1, day: 1, leap: false })
    expect(i.yearGanzhi).toBe('甲辰')
    expect(i.monthName + i.dayName).toBe('正月初一')
    expect(i.zodiac).toBe('龙')
    expect(i.week).toBe('星期六')
    expect(i.ganzhi).toBe('甲辰年 丙寅月 甲辰日')
  })

  it('2023 年闰二月：02-20 二月初一，03-22 闰二月初一，04-20 三月初一', () => {
    expect(toLunar(2023, 2, 20).monthName).toBe('二月')
    const leap = toLunar(2023, 3, 22)
    expect(leap.date).toEqual({ year: 2023, month: 2, day: 1, leap: true })
    expect(leap.monthName).toBe('闰二月')
    expect(leap.yearGanzhi).toBe('癸卯')
    expect(toLunar(2023, 4, 20).date).toEqual({ year: 2023, month: 3, day: 1, leap: false })
  })

  it('节气当天给出节气名，非节气日为 null', () => {
    expect(toLunar(2024, 2, 4).term).toBe('立春')
    expect(toLunar(2024, 2, 5).term).toBeNull()
    expect(toLunar(2024, 12, 21).term).toBe('冬至')
  })

  it('2026-10-13 = 丙午年九月初四（重阳 10-18 即初九）', () => {
    const i = toLunar(2026, 10, 13)
    expect(i.yearGanzhi + '年 ' + i.monthName + i.dayName).toBe('丙午年 九月初四')
  })

  it('立春前仍属上一农历年（2024-01-01 是癸卯年冬月）', () => {
    expect(toLunar(2024, 1, 1).yearGanzhi).toBe('癸卯')
  })
})

describe('阴历转阳历与往返', () => {
  it('已知：甲辰正月初一 = 2024-02-10；闰二月初一 = 2023-03-22', () => {
    expect(lunarToSolar({ year: 2024, month: 1, day: 1, leap: false })).toEqual({ ok: true, value: { year: 2024, month: 2, day: 10 } })
    expect(lunarToSolar({ year: 2023, month: 2, day: 1, leap: true })).toEqual({ ok: true, value: { year: 2023, month: 3, day: 22 } })
  })

  it('每隔 7 天抽样 2020 到 2026 年，阳历-阴历-阳历完全一致', () => {
    const start = Date.UTC(2020, 0, 1)
    for (let t = start; t < Date.UTC(2027, 0, 1); t += 7 * 86400000) {
      const d = new Date(t)
      const s: SolarDate = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
      const l = solarToLunar(s)
      expect(l.ok).toBe(true)
      if (!l.ok) return
      const back = lunarToSolar(l.value.date)
      expect(back).toEqual({ ok: true, value: s })
    }
  })
})

describe('输入解析与格式化', () => {
  it('阳历：格式化与解析互逆，补零', () => {
    expect(formatSolar({ year: 2026, month: 3, day: 5 })).toBe('2026-03-05')
    expect(parseSolar('2026-10-13')).toEqual({ ok: true, value: { year: 2026, month: 10, day: 13 } })
  })

  it('阴历：闰月末尾带「闰」', () => {
    expect(formatLunar({ year: 2023, month: 2, day: 1, leap: true })).toBe('2023-02-01闰')
    expect(formatLunar({ year: 2026, month: 9, day: 3, leap: false })).toBe('2026-09-03')
    expect(parseLunar('2026-06-15闰')).toMatchObject({ ok: false }) // 2026 没有闰六月
    expect(parseLunar('2023-02-01闰')).toEqual({ ok: true, value: { year: 2023, month: 2, day: 1, leap: true } })
  })

  it('没输完整不报错（incomplete）', () => {
    expect(parseSolar('2026-1')).toMatchObject({ ok: false, incomplete: true })
    expect(parseLunar('')).toMatchObject({ ok: false, incomplete: true })
    expect(parseLunar('2026-09-0')).toMatchObject({ ok: false, incomplete: true })
  })

  it('阳历非法：月 13、2 月 30、非闰年 2-29、年份超范围', () => {
    for (const t of ['2026-13-01', '2026-02-30', '2025-02-29', '0000-01-01', '10000-01-01', '1582-10-10', '0001-02-29']) {
      const r = parseSolar(t)
      expect(r.ok, t).toBe(false)
      if (!r.ok) expect(r.incomplete, t).toBe(false)
    }
    expect(parseSolar('2024-02-29').ok).toBe(true)
  })

  it('阴历非法：月 13、日 31、闰月不存在、某月只有 29 天却输 30、年份超范围', () => {
    const cases: [string, string][] = [
      ['2026-13-01', '1 到 12'],
      ['2026-00-01', '1 到 12'],
      ['2026-09-31', '1 到 30'],
      ['2026-09-00', '1 到 30'],
      ['2026-06-15闰', '没有闰6月'],
      ['2024-01-30', '只有 29 天'],
      ['0000-01-01', '仅支持'],
      ['10000-01-01', '仅支持'],
    ]
    for (const [t, msg] of cases) {
      const r = parseLunar(t)
      expect(r.ok, t).toBe(false)
      if (!r.ok) expect(r.error, t).toContain(msg)
    }
  })

  it('lunarToSolar 对非法输入直接报错而不是抛异常', () => {
    expect(lunarToSolar({ year: 2024, month: 1, day: 30, leap: false }).ok).toBe(false)
    expect(lunarToSolar({ year: 2024, month: 5, day: 1, leap: true }).ok).toBe(false)
  })
})

describe('历史日期（已知）', () => {
  it('1894-09-17 黄海海战 = 甲午年八月十八（光绪二十年）', () => {
    const i = toLunar(1894, 9, 17)
    expect(i.yearGanzhi).toBe('甲午')
    expect(i.monthName + i.dayName).toBe('八月十八')
    expect(i.zodiac).toBe('马')
  })

  it('1840 年：02-03 庚子年正月初一，前一天是己亥年腊月廿九；06-28 五月廿九', () => {
    const spring = toLunar(1840, 2, 3)
    expect(spring.yearGanzhi).toBe('庚子')
    expect(spring.monthName + spring.dayName).toBe('正月初一')
    expect(toLunar(1840, 2, 2).yearGanzhi).toBe('己亥')
    expect(toLunar(1840, 6, 28).monthName + toLunar(1840, 6, 28).dayName).toBe('五月廿九')
  })

  it('1582 历法改革：10-04（儒略）下一天是 10-15（格里高利），农历日序连续', () => {
    const a = toLunar(1582, 10, 4)
    const b = toLunar(1582, 10, 15)
    expect(a.monthName + a.dayName).toBe('九月十八')
    expect(b.monthName + b.dayName).toBe('九月十九')
    expect(parseSolar('1582-10-05').ok).toBe(false)
    expect(parseSolar('1582-10-14').ok).toBe(false)
    expect(parseSolar('1582-10-15').ok).toBe(true)
  })

  it('1582 前按儒略历：1500 年是闰年（2-29 存在），1700 年按格里高利不是闰年', () => {
    expect(parseSolar('1500-02-29').ok).toBe(true)
    expect(parseSolar('1700-02-29').ok).toBe(false)
    expect(parseSolar('0100-02-29').ok).toBe(true)
  })

  it('年份可不补零输入，格式化统一补成 4 位', () => {
    const r = parseSolar('1840-02-03')
    expect(r.ok).toBe(true)
    expect(parseSolar('800-01-01')).toEqual({ ok: true, value: { year: 800, month: 1, day: 1 } })
    expect(formatSolar({ year: 800, month: 1, day: 1 })).toBe('0800-01-01')
    expect(parseLunar('800-01-01')).toMatchObject({ ok: true })
  })
})

describe('范围边界', () => {
  it('阳历 1 年与 9999 年边界', () => {
    expect(solarToLunar({ year: 1, month: 6, day: 1 }).ok).toBe(true)
    expect(solarToLunar({ year: 9999, month: 12, day: 31 }).ok).toBe(true)
  })

  it('1-01-01 对应农历 0 年（公元前），给错误而非白屏', () => {
    expect(solarToLunar({ year: 1, month: 1, day: 1 }).ok).toBe(false)
  })

  it('农历 9999 年末几天对应阳历 10000 年，给行内错误；之前的月份正常', () => {
    const bad = lunarToSolar({ year: 9999, month: 12, day: 15, leap: false })
    expect(bad.ok).toBe(false)
    expect(lunarToSolar({ year: 9999, month: 12, day: 1, leap: false }).ok).toBe(true)
    expect(lunarToSolar({ year: 1, month: 1, day: 1, leap: false }).ok).toBe(true)
  })

  it('每 97 年抽样 1 到 9999 年，阳历-阴历-阳历一致', () => {
    for (let y = 1; y <= 9999; y += 97) {
      const s: SolarDate = { year: y, month: 7, day: 15 }
      const l = solarToLunar(s)
      expect(l.ok, String(y)).toBe(true)
      if (!l.ok) return
      expect(lunarToSolar(l.value.date), String(y)).toEqual({ ok: true, value: s })
    }
  })
})

describe('选择器选项', () => {
  it('年份列是窗口：以选中年为中心，不铺开上万项', () => {
    const y = yearOptions(1894)
    expect(y).toHaveLength(2 * YEAR_WINDOW + 1)
    expect(y[0]).toEqual({ value: 1894 - YEAR_WINDOW, text: `${1894 - YEAR_WINDOW}年` })
    expect(y[y.length - 1]!.value).toBe(1894 + YEAR_WINDOW)
  })

  it('年份窗口在两端被夹住，仍包含选中年', () => {
    expect(yearOptions(MIN_YEAR)[0]!.value).toBe(MIN_YEAR)
    expect(yearOptions(MIN_YEAR)).toHaveLength(YEAR_WINDOW + 1)
    expect(yearOptions(MAX_YEAR)[YEAR_WINDOW]!.value).toBe(MAX_YEAR)
  })

  it('阳历日选项：2 月看闰年，1582 年 10 月跳过 5 到 14 日', () => {
    expect(solarMonthOptions()).toHaveLength(12)
    expect(solarDayOptions(2024, 2)).toHaveLength(29)
    expect(solarDayOptions(2023, 2)).toHaveLength(28)
    expect(solarDayOptions(1500, 2)).toHaveLength(29)
    const oct = solarDayOptions(1582, 10).map((o) => o.value)
    expect(oct).toHaveLength(21)
    expect(oct.includes(4) && oct.includes(15) && !oct.includes(10)).toBe(true)
  })

  it('2023 有 13 个月，闰二月紧跟二月且值为 -2', () => {
    const m = lunarMonthOptions(2023)
    expect(m).toHaveLength(13)
    expect(m[1]).toEqual({ value: 2, text: '二月' })
    expect(m[2]).toEqual({ value: -2, text: '闰二月' })
    expect(lunarMonthOptions(2024)).toHaveLength(12)
  })

  it('日选项用中文名，天数与月大小一致', () => {
    const d = lunarDayOptions(2024, 1)
    expect(d).toHaveLength(lunarDayCount(2024, 1))
    expect(d[0]!.text).toBe('初一')
    expect(d[9]!.text).toBe('初十')
    expect(d[20]!.text).toBe('廿一')
  })

  it('今天返回合法阳历', () => {
    expect(parseSolar(formatSolar(todaySolar())).ok).toBe(true)
  })
})

describe('宜忌（数据来自 tyme4ts，可信度同库）', () => {
  it('2026-10-13：宜含嫁娶，忌含安葬，建除开，黄道金匮', () => {
    const i = toLunar(2026, 10, 13)
    expect(i.recommends).toContain('嫁娶')
    expect(i.avoids).toContain('安葬')
    expect(i.avoids).toContain('安床')
    expect(i.duty).toBe('开')
    expect(i.twelveStar).toBe('金匮')
    expect(i.ecliptic).toBe('黄道')
  })

  it('不同日期宜忌不同；黑道日标记黑道（1840-02-03 白虎）', () => {
    expect(toLunar(2024, 2, 10).recommends).not.toEqual(toLunar(2026, 10, 13).recommends)
    const b = toLunar(1840, 2, 3)
    expect(b.twelveStar).toBe('白虎')
    expect(b.ecliptic).toBe('黑道')
  })

  it('常规日期宜忌非空且宜忌互不重叠', () => {
    for (const [y, m, d] of [[2024, 2, 10], [2023, 3, 22], [1894, 9, 17], [1582, 10, 15], [1, 6, 1]] as const) {
      const i = toLunar(y, m, d)
      expect(i.recommends.length, `${y}-${m}-${d}`).toBeGreaterThan(0)
      expect(i.avoids.length, `${y}-${m}-${d}`).toBeGreaterThan(0)
      expect(i.recommends.filter((x) => i.avoids.includes(x))).toEqual([])
    }
  })

  it('同一天重复调用结果一致', () => {
    expect(toLunar(2026, 10, 13)).toEqual(toLunar(2026, 10, 13))
  })

  it('极端年份兜底：9999 年末取不到宜忌时给空值，转换不失败', () => {
    const r = solarToLunar({ year: 9999, month: 12, day: 31 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.recommends).toEqual([])
      expect(r.value.avoids).toEqual([])
      expect(r.value.duty).toBe('')
    }
    expect(toLunar(1, 2, 12).recommends.length).toBeGreaterThan(0)
  })
})
