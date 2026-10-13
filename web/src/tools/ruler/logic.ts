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
