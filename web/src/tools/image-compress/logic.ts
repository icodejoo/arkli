/**
 * 图片压缩工具的纯逻辑：选项 → 原生参数、能力开关、结果归一与提示文案。
 * 不依赖 DOM 与 bridge，便于单测。
 */
import { changeText, formatBytes } from '@/shared/image-calc'

/** 输出格式 */
export type CompressFormat = 'jpeg' | 'webp' | 'png'

/** PNG 压缩模式 */
export type PngMode = 'lossless' | 'palette'

/** 界面上的压缩选项 */
export interface CompressOptions {
  /** 输出格式 */
  format: CompressFormat
  /** 质量 1~100 */
  quality: number
  /** 最长边，0 为不限 */
  maxEdge: number
  /** 是否启用目标体积 */
  useTarget: boolean
  /** 目标体积（KB） */
  targetKb: number
  /** PNG 模式 */
  pngMode: PngMode
  /** 缩色颜色数 */
  colors: number
  /** 缩色是否抖动 */
  dither: boolean
  /** 是否保留 EXIF（仅 JPEG） */
  keepExif: boolean
}

/** 一个待处理输入的最小形状 */
export interface InputRef {
  /** 缓存相对路径 */
  path: string
  /** 显示名 */
  name: string
}

/** 当前路径下哪些选项可用 */
export interface Capabilities {
  /** 能否选 PNG 缩色 */
  pngPalette: boolean
  /** 能否设目标体积 */
  target: boolean
  /** 能否保留 EXIF */
  exif: boolean
}

/** 原生返回的单项结果 */
export interface NativeItem {
  /** 缓存路径 */
  path: string
  /** 建议保存名 */
  name: string
  /** MIME */
  mime: string
  /** 宽 */
  width: number
  /** 高 */
  height: number
  /** 成品字节数 */
  bytes: number
  /** 原图字节数 */
  srcBytes: number
  /** 体积比 */
  ratio: number
  /** 目标体积是否达成（仅设了目标时有） */
  targetReached?: boolean
}

/** 原生返回的失败项 */
export interface NativeFailed {
  /** 在 items 里的下标 */
  index: number
  /** 显示名 */
  name?: string
  /** 错误码 */
  code: string
  /** 说明 */
  message: string
}

/** 质量范围 */
export const QUALITY_MIN = 1
export const QUALITY_MAX = 100
/** 默认质量 */
export const QUALITY_DEFAULT = 80
/** 最长边预设，0 表示不限 */
export const EDGE_PRESETS = [0, 4096, 2048, 1080, 720]
/** 颜色数范围与默认 */
export const COLORS_MIN = 2
export const COLORS_MAX = 256
/** 默认目标体积（KB） */
export const TARGET_KB_DEFAULT = 200
/** 原生 maxEdge 下限，低于它的自定义值会被抬到这里 */
export const EDGE_MIN = 64
/** 1KB 的字节数 */
const KB = 1024
/** 原生每次最多处理的张数 */
export const MAX_ITEMS = 50

/** 缩色提示 */
export const PALETTE_HINT = '照片、渐变类图缩色后可能反而变大。'

/** 默认选项 */
export function defaultOptions(): CompressOptions {
  return {
    format: 'jpeg',
    quality: QUALITY_DEFAULT,
    maxEdge: 0,
    useTarget: false,
    targetKb: TARGET_KB_DEFAULT,
    pngMode: 'lossless',
    colors: COLORS_MAX,
    dither: false,
    keepExif: false,
  }
}

/** 可选输出格式 */
const FORMATS: readonly CompressFormat[] = ['jpeg', 'webp', 'png']
/** 可选 PNG 模式 */
const PNG_MODES: readonly PngMode[] = ['lossless', 'palette']

/**
 * 把缓存里读出的选项洗成合法选项：字段缺失或非法就用默认值；目标体积是输入框内容，不恢复。
 *
 * @param raw 缓存原值（任意类型）
 * @param webpOk 当前能否编码 WebP，不能时 webp 回落默认格式
 * @returns 合法的完整选项
 * @example sanitizeOptions({ format: 'png', quality: 999 }, true).quality // 默认质量
 */
export function sanitizeOptions(raw: unknown, webpOk = true): CompressOptions {
  const d = defaultOptions()
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Partial<Record<keyof CompressOptions, unknown>>
  const inRange = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
  return {
    ...d,
    format: FORMATS.includes(r.format as CompressFormat) && (webpOk || r.format !== 'webp') ? (r.format as CompressFormat) : d.format,
    quality: inRange(r.quality, QUALITY_MIN, QUALITY_MAX) ? r.quality : d.quality,
    maxEdge: EDGE_PRESETS.includes(r.maxEdge as number) ? (r.maxEdge as number) : d.maxEdge,
    useTarget: typeof r.useTarget === 'boolean' ? r.useTarget : d.useTarget,
    pngMode: PNG_MODES.includes(r.pngMode as PngMode) ? (r.pngMode as PngMode) : d.pngMode,
    colors: inRange(r.colors, COLORS_MIN, COLORS_MAX) ? r.colors : d.colors,
    dither: typeof r.dither === 'boolean' ? r.dither : d.dither,
    keepExif: typeof r.keepExif === 'boolean' ? r.keepExif : d.keepExif,
  }
}

/**
 * 当前路径下的选项可用性。Canvas 兜底只有质量、最长边与格式。
 *
 * @param native 是否有原生宿主
 * @param format 当前输出格式
 */
export function capabilities(native: boolean, format: CompressFormat): Capabilities {
  return {
    pngPalette: native,
    target: native && format !== 'png',
    exif: native && format === 'jpeg',
  }
}

/** 把数字夹到范围内并取整，非有限数取下界 */
export function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  return Math.min(max, Math.max(min, Math.round(v)))
}

/**
 * 组装 native.image.compress 的参数；只带当前格式下有意义的字段。
 *
 * @param items 输入（缓存路径 + 显示名）
 * @param o 选项
 */
export function buildParams(items: InputRef[], o: CompressOptions): Record<string, unknown> {
  const p: Record<string, unknown> = {
    items: items.map((i) => ({ path: i.path, name: i.name })),
    format: o.format,
    quality: clampInt(o.quality, QUALITY_MIN, QUALITY_MAX),
  }
  if (o.maxEdge > 0) p.maxEdge = clampInt(o.maxEdge, EDGE_MIN, 16384)
  if (o.format !== 'png' && o.useTarget && o.targetKb > 0) p.targetBytes = Math.round(o.targetKb * KB)
  if (o.format === 'png') {
    p.png = { mode: o.pngMode, colors: clampInt(o.colors, COLORS_MIN, COLORS_MAX), dither: o.pngMode === 'palette' && o.dither }
  }
  if (o.format === 'jpeg' && o.keepExif) p.keepExif = true
  return p
}

/**
 * 单项结果的说明文案：前后体积与变化；变大或目标未达成时追加提示。
 *
 * @param srcBytes 原图字节数
 * @param bytes 成品字节数
 * @param targetReached 目标体积是否达成，未设目标为 undefined
 */
export function resultNote(srcBytes: number, bytes: number, targetReached?: boolean): string {
  let s = `压缩前 ${formatBytes(srcBytes)}，${changeText(srcBytes, bytes)}`
  if (isBigger(srcBytes, bytes)) s += '。结果比原图大，建议保留原图或换格式、降质量'
  if (targetReached === false) s += '。未压到目标体积，已用最低质量'
  return s
}

/** 成品是否比原图大 */
export function isBigger(srcBytes: number, bytes: number): boolean {
  return srcBytes > 0 && bytes > srcBytes
}

/** 失败项的一行描述，如“a.jpg：无法解码（INTERNAL）” */
export function describeFailed(f: NativeFailed): string {
  return `${f.name ?? `第 ${f.index + 1} 张`}：${f.message}（${f.code}）`
}

/**
 * 解析 image.progress 事件数据，不合格返回 null。
 *
 * @param data 事件 data
 * @returns 形如 `2/5` 的文案
 */
export function progressText(data: unknown): string | null {
  const d = data as { done?: unknown; total?: unknown } | null
  if (!d || typeof d.done !== 'number' || typeof d.total !== 'number' || d.total <= 0) return null
  return `${d.done}/${d.total}`
}

/** 批量上限提示用：返回还能再选几张 */
export function roomLeft(current: number, max: number): number {
  return Math.max(0, Math.min(max, MAX_ITEMS) - current)
}
