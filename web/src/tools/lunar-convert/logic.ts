// 阳历/阴历互转：封装 tyme4ts，对外只暴露自己的简单结构（不泄漏库类型）
import { LunarDay, LunarMonth, LunarYear, SolarDay } from 'tyme4ts'
import { TABOO_NOTES } from './taboo-notes'

/** 支持的最小年份（tyme4ts 实测可用边界，阳历 1 年起） */
export const MIN_YEAR = 1
/** 支持的最大年份（阳历 9999 年止；10000 年库会抛错） */
export const MAX_YEAR = 9999
/** 选择器年份列的窗口半径：只生成「选中年 ± 该值」的年份，避免一次铺开上万项 */
export const YEAR_WINDOW = 60
/** 年份范围提示文案 */
export const RANGE_TEXT = `仅支持 ${MIN_YEAR} 到 ${MAX_YEAR} 年`
/** 宜忌说明 */
export const TABOO_NOTE = '宜忌为传统黄历推算，各流派略有差异，仅供参考。'
/** 历法说明：1582-10-04 前为儒略历，之后为格里高利历（库的实测行为） */
export const CALENDAR_NOTE = '1582 年 10 月 4 日前按儒略历、之后按格里高利历推算（10 月 5 至 14 日不存在）；古代农历为推算值，仅供参考。'
/** 闰月标记字符（写在阴历文本末尾） */
export const LEAP_MARK = '闰'

/** 阳历日期 */
export interface SolarDate {
  /** 年 */
  year: number
  /** 月，1 到 12 */
  month: number
  /** 日 */
  day: number
}

/** 阴历日期 */
export interface LunarDate {
  /** 农历年 */
  year: number
  /** 农历月，1 到 12 */
  month: number
  /** 农历日，1 到 30 */
  day: number
  /** 是否闰月 */
  leap: boolean
}

/** 阴历日期的完整中文描述 */
export interface LunarInfo {
  /** 对应的阴历日期 */
  date: LunarDate
  /** 年干支，如「甲辰」 */
  yearGanzhi: string
  /** 月名，如「正月」「闰二月」 */
  monthName: string
  /** 日名，如「初一」 */
  dayName: string
  /** 生肖 */
  zodiac: string
  /** 年月日干支，如「甲辰年 丙寅月 甲辰日」 */
  ganzhi: string
  /** 当天正好是节气时的节气名，否则为 null */
  term: string | null
  /** 星期，如「星期六」 */
  week: string
  /** 宜做的事（传统黄历），取不到时为空数组 */
  recommends: string[]
  /** 忌做的事，取不到时为空数组 */
  avoids: string[]
  /** 建除十二值星，如「开」；取不到时为空串 */
  duty: string
  /** 黄道十二神，如「金匮」；取不到时为空串 */
  twelveStar: string
  /** 黄道或黑道，如「黄道」；取不到时为空串 */
  ecliptic: string
}

/** 解析结果：成功带值；失败区分「还没输完」和「输完了但不合法」 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; incomplete: boolean; error: string }

/** 阳历文本完整形态：年 1 到 5 位（可不补零，5 位仅为给出范围提示），月日两位，如 2026-10-13、1-01-01 */
const SOLAR_FULL = /^(\d{1,5})-(\d{2})-(\d{2})$/
/** 阴历文本完整形态：同上，闰月末尾加「闰」，如 2026-09-03、2026-06-15闰 */
const LUNAR_FULL = /^(\d{1,5})-(\d{2})-(\d{2})(闰?)$/
/** 星期名前缀 */
const WEEK_PREFIX = '星期'

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
 * 执行取值函数，库在年份两端可能抛错（如 9999 年末月柱），此时返回 null / 空串，不影响主结果。
 *
 * @param f 取值函数
 * @returns 取值结果；抛错时为 null
 */
function safe<T extends string | null>(f: () => T): T | null {
  try {
    return f()
  } catch {
    return null
  }
}

/**
 * 同 safe，但取列表：库抛错时返回空数组。
 *
 * @param f 取值函数
 * @returns 取值结果；抛错时为 []
 */
function safeList(f: () => string[]): string[] {
  try {
    return f()
  } catch {
    return []
  }
}

/**
 * 把库抛出的异常转成可读文案。
 *
 * @param e 捕获到的异常
 * @returns 错误消息
 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : '日期不合法'
}

/** 历法改革空档提示 */
const GAP_TEXT = '1582 年 10 月 5 日至 14 日不存在（儒略历改格里高利历）'

/**
 * 是否落在 1582-10-05 到 1582-10-14 的历法改革空档。
 *
 * @param year 年
 * @param month 月
 * @param day 日
 * @returns 是则 true
 */
function isCalendarGap(year: number, month: number, day: number): boolean {
  return year === 1582 && month === 10 && day >= 5 && day <= 14
}

/**
 * 格式化阳历日期。
 *
 * @param d 阳历日期
 * @returns 如 '2026-10-13'
 */
export function formatSolar(d: SolarDate): string {
  return `${String(d.year).padStart(4, '0')}-${pad2(d.month)}-${pad2(d.day)}`
}

/**
 * 格式化阴历日期，闰月在末尾加「闰」。
 *
 * @param d 阴历日期
 * @returns 如 '2026-09-03'、'2023-02-01闰'
 */
export function formatLunar(d: LunarDate): string {
  return `${String(d.year).padStart(4, '0')}-${pad2(d.month)}-${pad2(d.day)}${d.leap ? LEAP_MARK : ''}`
}

/**
 * 解析阳历输入。没输完整时返回 incomplete，不报错。
 *
 * @param text 用户输入，如 '2026-10-13'
 * @returns 合法日期，或错误说明
 * @example parseSolar('2024-02-30') // { ok: false, incomplete: false, error: '...' }
 */
export function parseSolar(text: string): ParseResult<SolarDate> {
  const m = SOLAR_FULL.exec(text.trim())
  if (!m) return { ok: false, incomplete: true, error: '格式应为 2026-10-13' }
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (year < MIN_YEAR || year > MAX_YEAR) return { ok: false, incomplete: false, error: RANGE_TEXT }
  if (isCalendarGap(year, month, day)) return { ok: false, incomplete: false, error: GAP_TEXT }
  try {
    SolarDay.fromYmd(year, month, day)
  } catch (e) {
    return { ok: false, incomplete: false, error: errText(e) }
  }
  return { ok: true, value: { year, month, day } }
}

/**
 * 判断阴历日期的合法性并给出错误说明（年份范围、月日范围、闰月是否存在、当月天数）。
 *
 * @param d 阴历日期
 * @returns 合法返回 null，否则错误文案
 */
function checkLunar(d: LunarDate): string | null {
  if (d.year < MIN_YEAR || d.year > MAX_YEAR) return RANGE_TEXT
  if (d.month < 1 || d.month > 12) return '农历月份要在 1 到 12 之间'
  if (d.day < 1 || d.day > 30) return '农历日要在 1 到 30 之间'
  if (d.leap && LunarYear.fromYear(d.year).getLeapMonth() !== d.month) return `${d.year} 年没有闰${d.month}月`
  const count = lunarDayCount(d.year, d.leap ? -d.month : d.month)
  if (d.day > count) return `${d.year} 年${monthName(d.year, d.leap ? -d.month : d.month)}只有 ${count} 天`
  return null
}

/**
 * 解析阴历输入。没输完整时返回 incomplete，不报错。
 *
 * @param text 用户输入，如 '2026-09-03'、'2026-06-15闰'
 * @returns 合法日期，或错误说明
 * @example parseLunar('2023-02-01闰') // { ok: true, value: { year: 2023, month: 2, day: 1, leap: true } }
 */
export function parseLunar(text: string): ParseResult<LunarDate> {
  const m = LUNAR_FULL.exec(text.trim())
  if (!m) return { ok: false, incomplete: true, error: '格式应为 2026-09-03，闰月末尾加「闰」' }
  const value: LunarDate = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), leap: m[4] === LEAP_MARK }
  const error = checkLunar(value)
  return error ? { ok: false, incomplete: false, error } : { ok: true, value }
}

/**
 * 阳历转阴历，附带干支、生肖、节气、星期。
 *
 * @param d 阳历日期（需已通过 parseSolar 校验）
 * @returns 阴历信息；对应农历年超出支持范围时返回错误
 * @example solarToLunar({ year: 2024, month: 2, day: 10 }) // 甲辰年 正月初一
 */
export function solarToLunar(d: SolarDate): ParseResult<LunarInfo> {
  try {
    const solar = SolarDay.fromYmd(d.year, d.month, d.day)
    const lunar = solar.getLunarDay()
    const month = lunar.getLunarMonth()
    const year = month.getLunarYear()
    if (year.getYear() < MIN_YEAR || year.getYear() > MAX_YEAR) {
      return { ok: false, incomplete: false, error: `该日对应农历 ${year.getYear()} 年（公元前），${RANGE_TEXT}` }
    }
    const yearGanzhi = year.getSixtyCycle().getName()
    return {
      ok: true,
      value: {
        date: { year: year.getYear(), month: month.getMonth(), day: lunar.getDay(), leap: month.isLeap() },
        yearGanzhi,
        monthName: month.getName(),
        dayName: lunar.getName(),
        zodiac: year.getSixtyCycle().getEarthBranch().getZodiac().getName(),
        ganzhi: [`${yearGanzhi}年`, safe(() => `${lunar.getMonthSixtyCycle().getName()}月`), `${lunar.getSixtyCycle().getName()}日`].filter(Boolean).join(' '),
        term: safe(() => {
          const termDay = solar.getTermDay()
          return termDay.getDayIndex() === 0 ? termDay.getSolarTerm().getName() : null
        }),
        week: WEEK_PREFIX + solar.getWeek().getName(),
        recommends: safeList(() => solar.getSixtyCycleDay().getRecommends().map((x) => x.getName())),
        avoids: safeList(() => solar.getSixtyCycleDay().getAvoids().map((x) => x.getName())),
        duty: safe(() => lunar.getDuty().getName()) ?? '',
        twelveStar: safe(() => lunar.getTwelveStar().getName()) ?? '',
        ecliptic: safe(() => lunar.getTwelveStar().getEcliptic().getName()) ?? '',
      },
    }
  } catch (e) {
    return { ok: false, incomplete: false, error: errText(e) }
  }
}

/**
 * 阴历转阳历。
 *
 * @param d 阴历日期
 * @returns 阳历日期；非法或结果超出支持范围时返回错误
 * @example lunarToSolar({ year: 2023, month: 2, day: 1, leap: true }) // 2023-03-22
 */
export function lunarToSolar(d: LunarDate): ParseResult<SolarDate> {
  const error = checkLunar(d)
  if (error) return { ok: false, incomplete: false, error }
  try {
    const s = LunarDay.fromYmd(d.year, d.leap ? -d.month : d.month, d.day).getSolarDay()
    const value = { year: s.getYear(), month: s.getMonth(), day: s.getDay() }
    return { ok: true, value }
  } catch {
    // 阴历 9999 年末几天对应阳历 10000 年，库会抛错
    return { ok: false, incomplete: false, error: `对应的阳历超出 ${MAX_YEAR} 年，${RANGE_TEXT}` }
  }
}

/**
 * 今天的阳历日期（本机时区）。
 *
 * @returns 今天
 */
export function todaySolar(): SolarDate {
  const t = new Date()
  return { year: t.getFullYear(), month: t.getMonth() + 1, day: t.getDate() }
}

/** 选择器选项 */
export interface PickerOption {
  /** 选项值；月份里闰月用负数（-6 表示闰六月） */
  value: number
  /** 显示文字 */
  text: string
}

/**
 * 年份列选项：只生成「中心年 ± YEAR_WINDOW」，并夹在支持范围内。
 *
 * @param center 当前选中的年份
 * @returns 年份选项列表（最多 2 * YEAR_WINDOW + 1 项）
 * @example yearOptions(1894) // 1834年 … 1954年
 */
export function yearOptions(center: number): PickerOption[] {
  const list: PickerOption[] = []
  const from = Math.max(MIN_YEAR, center - YEAR_WINDOW)
  const to = Math.min(MAX_YEAR, center + YEAR_WINDOW)
  for (let y = from; y <= to; y++) list.push({ value: y, text: `${y}年` })
  return list
}

/**
 * 阳历月份选项（1 到 12 月）。
 *
 * @returns 12 项
 */
export function solarMonthOptions(): PickerOption[] {
  const list: PickerOption[] = []
  for (let m = 1; m <= 12; m++) list.push({ value: m, text: `${m}月` })
  return list
}

/**
 * 某阳历月的日选项；按库的历法判断，跳过不存在的日期（如 1582-10-05 至 14）。
 *
 * @param year 阳历年
 * @param month 阳历月
 * @returns 日选项列表
 */
export function solarDayOptions(year: number, month: number): PickerOption[] {
  const list: PickerOption[] = []
  for (let d = 1; d <= 31; d++) {
    if (isCalendarGap(year, month, d)) continue
    try {
      SolarDay.fromYmd(year, month, d)
      list.push({ value: d, text: `${d}日` })
    } catch {
      break
    }
  }
  return list
}

/**
 * 某农历年的月名，闰月带「闰」前缀。
 *
 * @param year 农历年
 * @param month 月份，闰月为负数
 * @returns 如 '正月'、'闰六月'
 */
function monthName(year: number, month: number): string {
  return LunarMonth.fromYm(year, month).getName()
}

/**
 * 某农历年的月份选项，闰月紧跟在本月之后。
 *
 * @param year 农历年
 * @returns 12 或 13 项
 */
export function lunarMonthOptions(year: number): PickerOption[] {
  const leap = LunarYear.fromYear(year).getLeapMonth()
  const list: PickerOption[] = []
  for (let m = 1; m <= 12; m++) {
    list.push({ value: m, text: monthName(year, m) })
    if (m === leap) list.push({ value: -m, text: monthName(year, -m) })
  }
  return list
}

/**
 * 某农历月的天数。
 *
 * @param year 农历年
 * @param month 月份，闰月为负数
 * @returns 29 或 30
 */
export function lunarDayCount(year: number, month: number): number {
  return LunarMonth.fromYm(year, month).getDayCount()
}

/**
 * 某农历月的日选项（初一到三十或廿九）。
 *
 * @param year 农历年
 * @param month 月份，闰月为负数
 * @returns 日选项列表
 */
export function lunarDayOptions(year: number, month: number): PickerOption[] {
  const list: PickerOption[] = []
  const count = lunarDayCount(year, month)
  for (let d = 1; d <= count; d++) list.push({ value: d, text: LunarDay.fromYmd(year, month, d).getName() })
  return list
}

/** 释义表里没有该事项时显示的文案 */
export const NO_NOTE_TEXT = '暂无说明'

/** 事项说明（给界面用） */
export interface TabooNoteView {
  /** 释义文字，查不到时为「暂无说明」 */
  text: string
  /** 释义是否待核对 */
  verify: boolean
  /** 参考来源简称；没有则为空串 */
  source: string
}

/**
 * 按事项名查通俗说明；查不到（如库升级后新增事项）时返回「暂无说明」，不抛错。
 *
 * @param name 宜忌事项名，如 '嫁娶'
 * @returns 说明与待核对标记
 * @example tabooNote('嫁娶').text // '结婚办喜事…'
 */
export function tabooNote(name: string): TabooNoteView {
  const n = Object.prototype.hasOwnProperty.call(TABOO_NOTES, name) ? TABOO_NOTES[name] : undefined
  return n ? { text: n.text, verify: n.verify === true, source: n.source ?? '' } : { text: NO_NOTE_TEXT, verify: false, source: '' }
}
