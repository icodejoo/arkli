// 尺子：刻度计算与校准比例的存取（与 Vue 解耦）

/** 1 英寸等于多少毫米 */
export const MM_PER_INCH = 25.4
/** 未校准时的默认比例：按 CSS 规范 96px = 1 英寸估算（像素/毫米） */
export const DEFAULT_PX_PER_MM = 96 / MM_PER_INCH
/** 银行卡/身份证长边，单位毫米 */
export const CARD_MM = 85.6
/** 一元硬币直径，单位毫米 */
export const COIN_MM = 25
/** 合理比例下限（像素/毫米），低于它视为数据异常 */
export const MIN_PX_PER_MM = 1
/** 合理比例上限（像素/毫米） */
export const MAX_PX_PER_MM = 12
/** localStorage 键前缀 */
export const STORAGE_PREFIX = 'arkli:ruler:'
/** 校准比例的存储键后缀 */
export const SCALE_KEY = 'scale'
/** 英寸刻度的最小分度（1/16 英寸） */
export const INCH_DIVISION = 16

/** 长度单位 */
export type RulerUnit = 'cm' | 'inch'

/** 刻度级别：major 带数字，half 中长，minor 最短 */
export type TickKind = 'major' | 'half' | 'minor'

/** 一根刻度线 */
export interface Tick {
  /** 距起点的像素位置 */
  pos: number
  /** 刻度级别 */
  kind: TickKind
  /** 主刻度的数字标签（仅 major 有） */
  label?: string
}

/** 键值存储的最小接口（便于测试注入） */
export interface KvStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * 判断比例是否为合法值。
 *
 * @param v 待检查的像素/毫米比例
 * @returns 有限数且落在合理范围内为 true
 */
export function isValidScale(v: number): boolean {
  return Number.isFinite(v) && v >= MIN_PX_PER_MM && v <= MAX_PX_PER_MM
}

/**
 * 由校准线的像素长度与已知实物长度算比例。
 *
 * @param px 用户把校准线拖到与实物等长时的像素长度
 * @param mm 实物真实长度（毫米）
 * @returns 像素/毫米；入参非法或结果不合理时返回 null
 * @example
 * scaleFromCalibration(323.5, 85.6) // 约 3.78
 */
export function scaleFromCalibration(px: number, mm: number): number | null {
  if (!(px > 0) || !(mm > 0)) return null
  const s = px / mm
  return isValidScale(s) ? s : null
}

/**
 * 生成指定长度内的全部刻度。
 *
 * @param lengthPx 尺子总长（像素）
 * @param pxPerMm 像素/毫米比例
 * @param unit 单位：厘米（1mm 一格）或英寸（1/16 英寸一格）
 * @returns 刻度数组，按位置升序；长度或比例非法时为空
 * @example
 * buildTicks(100, 4, 'cm')[10] // { pos: 40, kind: 'major', label: '1' }
 */
export function buildTicks(lengthPx: number, pxPerMm: number, unit: RulerUnit): Tick[] {
  if (!(lengthPx > 0) || !isValidScale(pxPerMm)) return []
  const ticks: Tick[] = []
  if (unit === 'cm') {
    const total = Math.floor(lengthPx / pxPerMm)
    for (let i = 0; i <= total; i++) {
      const pos = i * pxPerMm
      if (i % 10 === 0) ticks.push({ pos, kind: 'major', label: String(i / 10) })
      else ticks.push({ pos, kind: i % 5 === 0 ? 'half' : 'minor' })
    }
    return ticks
  }
  const pxPerStep = (pxPerMm * MM_PER_INCH) / INCH_DIVISION
  const total = Math.floor(lengthPx / pxPerStep)
  for (let i = 0; i <= total; i++) {
    const pos = i * pxPerStep
    if (i % INCH_DIVISION === 0) ticks.push({ pos, kind: 'major', label: String(i / INCH_DIVISION) })
    else ticks.push({ pos, kind: i % (INCH_DIVISION / 2) === 0 || i % (INCH_DIVISION / 4) === 0 ? 'half' : 'minor' })
  }
  return ticks
}

/**
 * 像素长度转实际长度的展示文本。
 *
 * @param px 像素长度
 * @param pxPerMm 像素/毫米比例
 * @param unit 单位
 * @returns 如「85.6 mm」或「3.37 in」；比例非法时返回空串
 */
export function formatLength(px: number, pxPerMm: number, unit: RulerUnit): string {
  if (!isValidScale(pxPerMm)) return ''
  const mm = px / pxPerMm
  return unit === 'cm' ? `${mm.toFixed(1)} mm` : `${(mm / MM_PER_INCH).toFixed(2)} in`
}

/**
 * 读取已保存的校准比例。
 *
 * @param storage 存储对象，缺省时返回 null
 * @returns 合法比例；没存过、损坏或存储不可用时为 null
 */
export function loadScale(storage: KvStorage | undefined): number | null {
  try {
    const raw = storage?.getItem(STORAGE_PREFIX + SCALE_KEY)
    if (raw == null) return null
    const v = Number(raw)
    return isValidScale(v) ? v : null
  } catch {
    return null
  }
}

/**
 * 保存校准比例。
 *
 * @param storage 存储对象
 * @param scale 像素/毫米比例
 * @returns 是否写入成功（比例非法或存储抛错时为 false）
 */
export function saveScale(storage: KvStorage | undefined, scale: number): boolean {
  if (!isValidScale(scale)) return false
  try {
    storage?.setItem(STORAGE_PREFIX + SCALE_KEY, String(scale))
    return !!storage
  } catch {
    return false
  }
}

/** 游标微调的步长，单位毫米 */
export const STEP_MM = 0.1
/** 每毫米对应的厘米数的倒数：10 毫米 = 1 厘米 */
const MM_PER_CM = 10
/** 标记颜色可选项：属于内容色，不随主题变，深浅色下都要看得清 */
export const MARK_COLORS = [
  { name: '亮绿', value: '#1fe05c' },
  { name: '红', value: '#e5484d' },
  { name: '橙', value: '#f08c00' },
  { name: '蓝', value: '#3b6cf6' },
  { name: '紫', value: '#9c36b5' },
] as const

/** 一条标记：位置按毫米存，改单位或重新校准后仍然对得上 */
export interface RulerMark {
  /** 标记编号，用于列表渲染与删除 */
  id: number
  /** 离零点的距离，单位毫米 */
  mm: number
  /** 线与读数的颜色 */
  color: string
}

/**
 * 像素距离换算成毫米。
 *
 * @param px 像素距离
 * @param pxPerMm 像素/毫米比例
 * @returns 毫米；比例非法时为 0
 * @example pxToMm(96, 96 / 25.4) // 25.4
 */
export function pxToMm(px: number, pxPerMm: number): number {
  return isValidScale(pxPerMm) ? px / pxPerMm : 0
}

/**
 * 毫米换算成像素距离。
 *
 * @param mm 毫米
 * @param pxPerMm 像素/毫米比例
 * @returns 像素；比例非法时为 0
 * @example mmToPx(25.4, 96 / 25.4) // 96
 */
export function mmToPx(mm: number, pxPerMm: number): number {
  return isValidScale(pxPerMm) ? mm * pxPerMm : 0
}

/**
 * 把游标位置限制在尺子范围内。
 *
 * @param px 想要的位置（像素）
 * @param max 尺子长度（像素）
 * @returns 落在 [0, max] 内的位置；输入不是有限数字时为 0
 * @example clampPos(-5, 600) // 0
 */
export function clampPos(px: number, max: number): number {
  if (!Number.isFinite(px)) return 0
  return Math.max(0, Math.min(Math.max(0, max), px))
}

/**
 * 游标读数的主显示：厘米档显示厘米（两位小数，即 0.1 毫米精度），英寸档显示英寸。
 *
 * @param mm 毫米
 * @param unit 当前单位
 * @returns 如 `5.37 cm`、`2.11 in`
 * @example formatReading(53.7, 'cm') // '5.37 cm'
 */
export function formatReading(mm: number, unit: RulerUnit): string {
  return unit === 'cm' ? `${(mm / MM_PER_CM).toFixed(2)} cm` : `${(mm / MM_PER_INCH).toFixed(2)} in`
}

/**
 * 游标读数的辅助显示：厘米档附带英寸，英寸档附带毫米，方便对照。
 *
 * @param mm 毫米
 * @param unit 当前单位
 * @returns 如 `53.7 mm · 2.11 in`、`53.7 mm`
 * @example formatReadingAlt(25.4, 'inch') // '25.4 mm'
 */
export function formatReadingAlt(mm: number, unit: RulerUnit): string {
  const mmText = `${mm.toFixed(1)} mm`
  return unit === 'cm' ? `${mmText} · ${(mm / MM_PER_INCH).toFixed(2)} in` : mmText
}
