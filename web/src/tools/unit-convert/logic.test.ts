import { describe, expect, it } from 'vitest'
import { CATEGORIES, convert, findUnit, formatNumber, parseNumber } from './logic'

/** 断言换算结果（按显示精度比较） */
function expectConv(v: number, from: string, to: string, expected: string): void {
  expect(formatNumber(convert(v, from, to))).toBe(expected)
}

describe('convert', () => {
  it('长度', () => {
    expectConv(1, 'len.mi', 'len.km', '1.609344')
    expectConv(1, 'len.zhang', 'len.chi', '10')
    expectConv(1, 'len.li', 'len.m', '500')
    expectConv(12, 'len.in', 'len.ft', '1')
  })
  it('面积：1 亩约 666.67 平方米', () => {
    expect(convert(1, 'area.mu', 'area.m2')).toBeCloseTo(666.6667, 3)
    expectConv(1, 'area.ha', 'area.m2', '10000')
  })
  it('体积', () => {
    expectConv(1, 'vol.gal', 'vol.l', '3.785411784')
    expectConv(1, 'vol.m3', 'vol.l', '1000')
  })
  it('质量：斤两磅', () => {
    expectConv(1, 'mass.jin', 'mass.liang', '10')
    expectConv(1, 'mass.lb', 'mass.g', '453.59237')
  })
  it('温度：仿射', () => {
    expectConv(0, 'temp.c', 'temp.f', '32')
    expectConv(100, 'temp.c', 'temp.f', '212')
    expectConv(212, 'temp.f', 'temp.c', '100')
    expectConv(0, 'temp.k', 'temp.c', '-273.15')
    expectConv(-40, 'temp.c', 'temp.f', '-40')
  })
  it('速度', () => {
    expectConv(36, 'speed.kmh', 'speed.ms', '10')
  })
  it('时间', () => {
    expectConv(1, 'time.d', 'time.h', '24')
    expectConv(90, 'time.min', 'time.h', '1.5')
  })
  it('压强与能量与功率', () => {
    expectConv(1, 'press.atm', 'press.kpa', '101.325')
    expectConv(1, 'energy.kcal', 'energy.kj', '4.184')
    expectConv(1, 'energy.kwh', 'energy.j', '3600000')
    expectConv(1, 'power.kw', 'power.w', '1000')
  })
  it('数据存储按 1024', () => {
    expectConv(1, 'data.gb', 'data.mb', '1024')
    expectConv(1, 'data.b', 'data.bit', '8')
  })
  it('角度与频率', () => {
    expectConv(180, 'angle.deg', 'angle.rad', '3.14159265359')
    expectConv(1, 'angle.turn', 'angle.deg', '360')
    expectConv(1, 'freq.ghz', 'freq.mhz', '1000')
  })
  it('未知单位返回 NaN', () => {
    expect(convert(1, 'nope', 'len.m')).toBeNaN()
  })
})

describe('formatNumber', () => {
  it('浮点误差被消掉', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
  })
  it('负零、非有限数', () => {
    expect(formatNumber(-0)).toBe('0')
    expect(formatNumber(NaN)).toBe('—')
    expect(formatNumber(Infinity)).toBe('—')
  })
  it('极小极大数用科学计数', () => {
    expect(formatNumber(1.5e-9)).toBe('1.5e-9')
  })
})

describe('parseNumber', () => {
  it('正常与异常', () => {
    expect(parseNumber(' 3.5 ')).toBe(3.5)
    expect(parseNumber('-2')).toBe(-2)
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('abc')).toBeNull()
    expect(parseNumber('Infinity')).toBeNull()
  })
})

describe('单位表自检', () => {
  it('id 全局唯一，每个单位有线性系数或仿射函数', () => {
    const ids = CATEGORIES.flatMap((c) => c.units.map((x) => x.id))
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of CATEGORIES) {
      for (const x of c.units) {
        expect(x.factor !== undefined || (x.toBase && x.fromBase)).toBeTruthy()
        expect(x.id.startsWith(c.id + '.')).toBe(true)
      }
    }
  })
  it('findUnit', () => {
    expect(findUnit('len.m')?.name).toBe('米')
    expect(findUnit('x')).toBeUndefined()
  })
})
