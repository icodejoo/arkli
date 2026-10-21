// 尺子：刻度计算与校准比例的存取（与 Vue 解耦）
import { createToolStorage, type ToolStorage } from '../../shared/toolStorage'

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
/** 工具持久缓存的命名空间 */
export const TOOL_NS = 'ruler'
/** 旧版 localStorage 里校准比例的完整键（仅用于迁移） */
export const LEGACY_SCALE_KEY = 'arkli:ruler:scale'
/** 校准比例的缓存键 */
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
 * 读取已保存的校准比例；首次读取时迁移旧键。
 *
 * @param store 持久缓存，默认本工具命名空间
 * @returns 合法比例；没存过、损坏或存储不可用时为 null
 */
export function loadScale(store: ToolStorage = createToolStorage(TOOL_NS)): number | null {
  store.adoptLegacy(LEGACY_SCALE_KEY, SCALE_KEY)
  const v = Number(store.get<unknown>(SCALE_KEY, null))
  return store.has(SCALE_KEY) && isValidScale(v) ? v : null
}

/**
 * 保存校准比例。
 *
 * @param scale 像素/毫米比例
 * @param store 持久缓存，默认本工具命名空间
 * @returns 是否写入成功（比例非法或存储不可用时为 false）
 */
export function saveScale(scale: number, store: ToolStorage = createToolStorage(TOOL_NS)): boolean {
  return isValidScale(scale) && store.set(SCALE_KEY, scale)
}

/**
 * 校验缓存的十六进制颜色（#rgb 或 #rrggbb）。
 *
 * @param v 缓存值
 * @returns 合法返回 true
 */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)
}

/** 游标微调的步长，单位毫米 */
export const STEP_MM = 0.1
/** 每毫米对应的厘米数的倒数：10 毫米 = 1 厘米 */
const MM_PER_CM = 10
/** 标记颜色预设：彩虹七色，从亮绿开始循环（默认第一个是亮绿）；属于内容色，不随主题变 */
export const MARK_COLORS = [
  { name: '亮绿', value: '#1fe05c' },
  { name: '青', value: '#00c2d1' },
  { name: '蓝', value: '#3b6cf6' },
  { name: '紫', value: '#9c36b5' },
  { name: '红', value: '#e5484d' },
  { name: '橙', value: '#f08c00' },
  { name: '黄', value: '#f2c200' },
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

/**
 * 取循环里的下一个颜色下标，走到末尾回到开头。
 *
 * @param index 当前下标
 * @param count 颜色总数
 * @returns 下一个下标；总数不合法时为 0
 * @example nextColorIndex(6, 7) // 0
 */
export function nextColorIndex(index: number, count: number): number {
  if (!(count > 0)) return 0
  return (Math.floor(index) + 1) % count
}

/** 间距对比最多同时选中的标记数 */
export const COMPARE_MAX = 2

/**
 * 按在尺上的位置从小到大排列标记（不改动原数组）。
 *
 * @param marks 标记列表
 * @returns 新数组，位置相同的保持原有先后顺序
 * @example sortMarksByPosition([{ id: 1, mm: 30, color: '#f00' }, { id: 2, mm: 10, color: '#0f0' }]).map(m => m.id) // [2, 1]
 */
export function sortMarksByPosition(marks: readonly RulerMark[]): RulerMark[] {
  return marks.map((m, i) => ({ m, i })).sort((a, b) => a.m.mm - b.m.mm || a.i - b.i).map((x) => x.m)
}

/**
 * 点选标记：已选的再点就取消；没选的就加入，超过上限时挤掉最早选的那条。
 *
 * @param picked 当前已选的标记编号（先选的在前）
 * @param id 刚点的标记编号
 * @returns 新的已选编号数组（不改动入参）
 * @example togglePick([1, 2], 3) // [2, 3]
 */
export function togglePick(picked: readonly number[], id: number): number[] {
  if (picked.includes(id)) return picked.filter((p) => p !== id)
  return [...picked, id].slice(-COMPARE_MAX)
}

/**
 * 两个位置之间的间距（取绝对值）。
 *
 * @param aMm 位置 A，毫米
 * @param bMm 位置 B，毫米
 * @returns 间距，毫米，非负
 * @example gapMm(30, 12.5) // 17.5
 */
export function gapMm(aMm: number, bMm: number): number {
  return Math.abs(aMm - bMm)
}

/**
 * 由原生屏幕的物理 dpi 估算「每毫米多少 CSS 像素」，免银行卡校准。
 *
 * 尺子沿屏幕长边（纵向）画，所以优先用 ydpi，没有再用 xdpi。
 * 物理像素要除以 devicePixelRatio 才是 CSS 像素。densityDpi 是密度桶、不够准，不参与。
 *
 * @param display 原生屏幕参数（只用到 xdpi / ydpi），可为 null
 * @param dpr 页面 devicePixelRatio
 * @returns 合法比例；数据缺失、非法或超出合理范围时为 null
 * @example
 * scaleFromDpi({ xdpi: 400, ydpi: 403 }, 2.625) // ≈ 6.04 px/mm
 */
export function scaleFromDpi(display: { xdpi?: number | null; ydpi?: number | null } | null, dpr: number): number | null {
  if (!display || !Number.isFinite(dpr) || dpr <= 0) return null
  for (const dpi of [display.ydpi, display.xdpi]) {
    if (typeof dpi === 'number' && Number.isFinite(dpi) && dpi > 0) {
      const s = dpi / MM_PER_INCH / dpr
      return isValidScale(s) ? s : null
    }
  }
  return null
}

/**
 * 决定生效的比例：手动校准 > 原生 dpi 自动值 > 96dpi 估算。
 *
 * @param saved 用户手动校准值
 * @param auto 原生 dpi 自动值
 * @returns 像素/毫米
 * @example
 * resolveScale(null, 6.04) // 6.04
 */
export function resolveScale(saved: number | null, auto: number | null): number {
  return saved ?? auto ?? DEFAULT_PX_PER_MM
}
