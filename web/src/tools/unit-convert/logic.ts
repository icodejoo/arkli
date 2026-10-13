// 单位换算：表驱动，每类有基准单位；温度用仿射函数

/** 显示精度（有效数字位数） */
const PRECISION = 12

/** 单位定义：线性单位给 factor（1 个该单位 = factor 个基准单位），仿射单位给 toBase/fromBase */
export interface Unit {
  /** 全局唯一 id，形如 `len.m` */
  id: string
  /** 展示名 */
  name: string
  /** 线性系数 */
  factor?: number
  /** 仿射：转为基准单位 */
  toBase?: (v: number) => number
  /** 仿射：从基准单位转回 */
  fromBase?: (v: number) => number
}

/** 单位类别 */
export interface Category {
  /** 类别 id */
  id: string
  /** 类别名 */
  name: string
  /** 补充说明（可选） */
  note?: string
  /** 该类下的单位 */
  units: Unit[]
}

/** 简写：线性单位 */
const u = (id: string, name: string, factor: number): Unit => ({ id, name, factor })

/** 全部类别与单位。市制（里丈尺寸、斤两、亩）并入长度、质量、面积 */
export const CATEGORIES: Category[] = [
  {
    id: 'len',
    name: '长度',
    units: [
      u('len.mm', '毫米', 0.001),
      u('len.cm', '厘米', 0.01),
      u('len.m', '米', 1),
      u('len.km', '千米', 1000),
      u('len.in', '英寸', 0.0254),
      u('len.ft', '英尺', 0.3048),
      u('len.yd', '码', 0.9144),
      u('len.mi', '英里', 1609.344),
      u('len.nmi', '海里', 1852),
      u('len.li', '里', 500),
      u('len.zhang', '丈', 10 / 3),
      u('len.chi', '尺', 1 / 3),
      u('len.cun', '寸', 1 / 30),
    ],
  },
  {
    id: 'area',
    name: '面积',
    units: [
      u('area.cm2', '平方厘米', 1e-4),
      u('area.m2', '平方米', 1),
      u('area.ha', '公顷', 1e4),
      u('area.km2', '平方千米', 1e6),
      u('area.in2', '平方英寸', 0.00064516),
      u('area.ft2', '平方英尺', 0.09290304),
      u('area.yd2', '平方码', 0.83612736),
      u('area.ac', '英亩', 4046.8564224),
      u('area.mu', '亩', 10000 / 15),
    ],
  },
  {
    id: 'vol',
    name: '体积',
    note: '加仑、夸脱、品脱、液量盎司按美制',
    units: [
      u('vol.ml', '毫升', 0.001),
      u('vol.l', '升', 1),
      u('vol.m3', '立方米', 1000),
      u('vol.ft3', '立方英尺', 28.316846592),
      u('vol.floz', '液量盎司', 0.0295735295625),
      u('vol.pt', '品脱', 0.473176473),
      u('vol.qt', '夸脱', 0.946352946),
      u('vol.gal', '加仑', 3.785411784),
    ],
  },
  {
    id: 'mass',
    name: '质量',
    units: [
      u('mass.mg', '毫克', 1e-6),
      u('mass.g', '克', 0.001),
      u('mass.kg', '千克', 1),
      u('mass.t', '吨', 1000),
      u('mass.ct', '克拉', 0.0002),
      u('mass.oz', '盎司', 0.028349523125),
      u('mass.lb', '磅', 0.45359237),
      u('mass.jin', '斤', 0.5),
      u('mass.liang', '两', 0.05),
    ],
  },
  {
    id: 'temp',
    name: '温度',
    units: [
      { id: 'temp.c', name: '摄氏度', factor: 1, toBase: (v) => v, fromBase: (v) => v },
      {
        id: 'temp.f',
        name: '华氏度',
        toBase: (v) => ((v - 32) * 5) / 9,
        fromBase: (v) => (v * 9) / 5 + 32,
      },
      { id: 'temp.k', name: '开尔文', toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
    ],
  },
  {
    id: 'speed',
    name: '速度',
    units: [
      u('speed.ms', '米/秒', 1),
      u('speed.kmh', '千米/时', 1 / 3.6),
      u('speed.mph', '英里/时', 0.44704),
      u('speed.kn', '节', 1852 / 3600),
    ],
  },
  {
    id: 'time',
    name: '时间',
    note: '1 年按 365 天',
    units: [
      u('time.ms', '毫秒', 0.001),
      u('time.s', '秒', 1),
      u('time.min', '分钟', 60),
      u('time.h', '小时', 3600),
      u('time.d', '天', 86400),
      u('time.w', '周', 604800),
      u('time.y', '年', 31536000),
    ],
  },
  {
    id: 'press',
    name: '压强',
    units: [
      u('press.pa', '帕', 1),
      u('press.kpa', '千帕', 1000),
      u('press.mpa', '兆帕', 1e6),
      u('press.bar', '巴', 1e5),
      u('press.atm', '标准大气压', 101325),
      u('press.mmhg', '毫米汞柱', 133.322387415),
      u('press.psi', '磅力/平方英寸', 6894.757293168),
    ],
  },
  {
    id: 'energy',
    name: '能量',
    note: '卡为热化学卡（1 卡 = 4.184 焦）',
    units: [
      u('energy.j', '焦耳', 1),
      u('energy.kj', '千焦', 1000),
      u('energy.cal', '卡', 4.184),
      u('energy.kcal', '千卡', 4184),
      u('energy.wh', '瓦时', 3600),
      u('energy.kwh', '千瓦时', 3.6e6),
      u('energy.btu', '英热单位', 1055.05585262),
    ],
  },
  {
    id: 'power',
    name: '功率',
    units: [
      u('power.w', '瓦', 1),
      u('power.kw', '千瓦', 1000),
      u('power.mw', '兆瓦', 1e6),
      u('power.ps', '公制马力', 735.49875),
    ],
  },
  {
    id: 'data',
    name: '数据存储',
    note: '按 1024 进制（KB = 1024 B）',
    units: [
      u('data.bit', '比特', 0.125),
      u('data.b', '字节 B', 1),
      u('data.kb', 'KB', 1024),
      u('data.mb', 'MB', 1024 ** 2),
      u('data.gb', 'GB', 1024 ** 3),
      u('data.tb', 'TB', 1024 ** 4),
    ],
  },
  {
    id: 'angle',
    name: '角度',
    units: [
      u('angle.deg', '度', 1),
      u('angle.min', '角分', 1 / 60),
      u('angle.sec', '角秒', 1 / 3600),
      u('angle.rad', '弧度', 180 / Math.PI),
      u('angle.grad', '百分度', 0.9),
      u('angle.turn', '圈', 360),
    ],
  },
  {
    id: 'freq',
    name: '频率',
    units: [u('freq.hz', '赫兹', 1), u('freq.khz', '千赫', 1e3), u('freq.mhz', '兆赫', 1e6), u('freq.ghz', '吉赫', 1e9)],
  },
]

/** 单位 id 到 { 类别, 单位 } 的索引 */
const INDEX = new Map<string, Unit>(CATEGORIES.flatMap((c) => c.units.map((x) => [x.id, x] as const)))

/**
 * 按 id 取单位。
 *
 * @param id 单位 id
 * @returns 单位；不存在为 undefined
 */
export function findUnit(id: string): Unit | undefined {
  return INDEX.get(id)
}

/**
 * 把单位上的值换成基准单位。
 *
 * @param unit 单位
 * @param v 数值
 * @returns 基准单位下的数值
 */
function toBase(unit: Unit, v: number): number {
  return unit.toBase ? unit.toBase(v) : v * (unit.factor as number)
}

/**
 * 把基准单位的值换成目标单位。
 *
 * @param unit 目标单位
 * @param v 基准单位下的数值
 * @returns 目标单位下的数值
 */
function fromBase(unit: Unit, v: number): number {
  return unit.fromBase ? unit.fromBase(v) : v / (unit.factor as number)
}

/**
 * 同类单位间换算。
 *
 * @param value 数值
 * @param fromId 源单位 id
 * @param toId 目标单位 id
 * @returns 结果；单位不存在返回 NaN
 * @example convert(1, 'len.mi', 'len.km') // 约 1.609344
 */
export function convert(value: number, fromId: string, toId: string): number {
  const a = findUnit(fromId)
  const b = findUnit(toId)
  if (!a || !b) return NaN
  return fromBase(b, toBase(a, value))
}

/**
 * 数字格式化：保留 12 位有效数字并去掉尾零，避免 0.30000000000000004。
 *
 * @param n 数值
 * @returns 文本；非有限数返回 '—'
 * @example formatNumber(0.1 + 0.2) // '0.3'
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const r = Number(n.toPrecision(PRECISION))
  return Object.is(r, -0) ? '0' : String(r)
}

/**
 * 解析输入框文本为数字。
 *
 * @param text 输入
 * @returns 数字；空或非法返回 null
 */
export function parseNumber(text: string): number | null {
  const s = text.trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
