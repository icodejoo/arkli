/**
 * 图片拼接工具的纯逻辑：原生参数、覆盖原图的前端预检与错误文案、待丢弃产物收集。
 * 不依赖 DOM 与 bridge，便于单测。
 */
import type { StitchAlign, StitchDirection } from '@/shared/image-calc'

/** 输出格式 */
export type StitchFormat = 'png' | 'jpeg'

/** 拼接选项 */
export interface StitchOptions {
  /** 方向 */
  direction: StitchDirection
  /** 间距 */
  gap: number
  /** 背景色 */
  bg: string
  /** 对齐 */
  align: StitchAlign
  /** 是否统一宽/高 */
  unify: boolean
  /** 输出格式 */
  format: StitchFormat
}

/** 原生拼接返回 */
export interface NativeStitchResult {
  /** 成品缓存路径 */
  path: string
  /** 缩略图缓存路径 */
  thumbPath: string
  /** 建议保存名 */
  name: string
  /** 宽 */
  width: number
  /** 高 */
  height: number
  /** 成品字节数 */
  size: number
}

/** 覆盖按钮的预检结果 */
export interface OverwriteCheck {
  /** 是否显示按钮（没有原图句柄就隐藏） */
  visible: boolean
  /** 是否禁用 */
  disabled: boolean
  /** 禁用时旁边的提示，可用时为空串 */
  hint: string
}

/** 输出 JPEG 质量（Canvas 与原生共用） */
export const JPEG_QUALITY = 0.92
/** 间距上限（像素） */
export const GAP_MAX = 200
/** 缓存路径在页面里的同源前缀 */
export const FILES_URL_PREFIX = '/files/'
/** 输出格式默认值：JPEG 编码快、体积小 */
export const DEFAULT_FORMAT: StitchFormat = 'jpeg'
/** PNG 预计像素超过它时提示编码较慢（真机实测 2400 万像素 PNG 约 4~5 秒，JPEG 不到 1 秒） */
export const PNG_SLOW_PIXELS = 20_000_000
/** PNG 像素多时的提示 */
export const PNG_SLOW_HINT = 'PNG 无损，像素多时编码较慢，建议用 JPEG'
/** 原生 PNG 压缩的像素上限，与 ImageConst.MAX_PNG_PIXELS 保持一致 */
export const PNG_COMPRESS_MAX_PIXELS = 16_000_000
/** 缩放取整会让像素略超，留 1% 余量 */
const PNG_COMPRESS_SAFETY = 0.99
/** 原图不是 PNG/JPEG 时的禁用提示 */
export const FORMAT_UNSUPPORTED_HINT = '原图不是 PNG 或 JPEG，无法覆盖'
/** 格式的显示名 */
const FORMAT_LABEL: Record<StitchFormat, string> = { png: 'PNG', jpeg: 'JPEG' }
/** 进度换算成百分比的满值 */
const PERCENT_FULL = 100

/** 覆盖失败文案 */
const MSG_PERMISSION = '未获得修改授权'
const MSG_NOT_READY = '需要 Android 11 及以上'
const MSG_STALE = '原图句柄已失效，请重新选择图片'
const MSG_MISMATCH = '格式与原图不同，请把输出格式改成一致'
const MSG_FALLBACK = '覆盖失败'
/** 原生 NOT_READY 文案里标识“系统版本不够”的关键词 */
const KEY_ANDROID = 'Android'
/** 原生 BAD_PARAMS 文案里标识“句柄过期”的关键词 */
const KEY_HANDLE = 'handle'

/**
 * 组装 native.image.stitch 的参数；JPEG 才带质量。
 *
 * @param paths 按拼接顺序的图片缓存路径
 * @param o 拼接选项
 * @returns 原生参数
 * @example buildStitchParams(['cache/pick/a.jpg', 'cache/pick/b.jpg'], opts)
 */
export function buildStitchParams(paths: string[], o: StitchOptions): Record<string, unknown> {
  const p: Record<string, unknown> = {
    items: paths.map((path) => ({ path })),
    direction: o.direction,
    gap: Math.min(GAP_MAX, Math.max(0, Math.round(o.gap))),
    bg: o.bg,
    align: o.align,
    unify: o.unify,
    format: o.format,
  }
  if (o.format === 'jpeg') p.quality = JPEG_QUALITY
  return p
}

/**
 * MIME 归一为 png / jpeg，其余（webp、heic 等）返回 null。
 *
 * @param mime 如 image/jpeg、image/jpg
 */
export function formatOfMime(mime: string | undefined): StitchFormat | null {
  const m = (mime ?? '').toLowerCase()
  if (m === 'image/png') return 'png'
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpeg'
  return null
}

/**
 * 覆盖原图的前端预检：无句柄隐藏；输出格式与原图不一致（或原图不是 png/jpeg）禁用并给提示。
 *
 * @param source 当前第一张原图，没有图为 undefined
 * @param outFormat 成品格式
 * @returns 可见性、禁用状态、提示
 */
export function checkOverwrite(source: { mime: string; sourceHandle?: string } | undefined, outFormat: StitchFormat): OverwriteCheck {
  if (!source?.sourceHandle) return { visible: false, disabled: true, hint: '' }
  const src = formatOfMime(source.mime)
  if (!src) return { visible: true, disabled: true, hint: FORMAT_UNSUPPORTED_HINT }
  if (src !== outFormat) {
    return { visible: true, disabled: true, hint: `原图是 ${FORMAT_LABEL[src]}，请把输出格式切到 ${FORMAT_LABEL[src]}` }
  }
  return { visible: true, disabled: false, hint: '' }
}

/**
 * 覆盖失败的人话文案。
 *
 * @param e 原生抛出的 { code, message }
 */
export function overwriteErrorText(e: unknown): string {
  const err = (e ?? {}) as { code?: string; message?: string }
  switch (err.code) {
    case 'FORMAT_MISMATCH':
      return MSG_MISMATCH
    case 'PERMISSION_DENIED':
      return MSG_PERMISSION
    case 'NOT_READY':
      return err.message?.includes(KEY_ANDROID) ? MSG_NOT_READY : err.message || MSG_NOT_READY
    case 'BAD_PARAMS':
      return err.message?.includes(KEY_HANDLE) ? MSG_STALE : err.message || MSG_FALLBACK
    default:
      return err.message ? `${MSG_FALLBACK}：${err.message}` : MSG_FALLBACK
  }
}

/**
 * 覆盖前二次确认的文案。
 *
 * @param name 当前第一张原图的文件名
 */
export function confirmText(name: string): string {
  return `将覆盖第一张原图 ${name}，不可撤销`
}

/**
 * 收集要丢弃的产物路径：去空去重。
 *
 * @param paths 各产物的路径，允许 undefined
 */
export function outputsToDiscard(...paths: Array<string | undefined>): string[] {
  return Array.from(new Set(paths.filter((p): p is string => !!p)))
}

/**
 * 缓存相对路径转页面同源地址。
 *
 * @param path 如 cache/out/a.png
 */
export function filesUrl(path: string): string {
  return FILES_URL_PREFIX + path
}

/**
 * PNG 且预计像素很多时的提示，否则空串。
 *
 * @param format 当前输出格式
 * @param width 预计输出宽
 * @param height 预计输出高
 */
export function pngSlowHint(format: StitchFormat, width: number, height: number): string {
  return format === 'png' && width * height > PNG_SLOW_PIXELS ? PNG_SLOW_HINT : ''
}

/**
 * 压缩 PNG 成品时需要的最长边：原生 PNG 压缩最多处理 [PNG_COMPRESS_MAX_PIXELS] 像素，
 * 超出会报"过大"，所以先按比例缩到上限以内。不需要缩时返回 0（即不传 maxEdge）。
 *
 * @param format 成品格式
 * @param width 成品宽
 * @param height 成品高
 * @returns 最长边上限；0 表示不用缩
 * @example pngCompressMaxEdge('png', 8000, 4000) // 2 千多万像素 → 约 5600
 */
export function pngCompressMaxEdge(format: StitchFormat, width: number, height: number): number {
  const pixels = width * height
  if (format !== 'png' || pixels <= PNG_COMPRESS_MAX_PIXELS) return 0
  return Math.floor(Math.max(width, height) * Math.sqrt((PNG_COMPRESS_MAX_PIXELS * PNG_COMPRESS_SAFETY) / pixels))
}

/**
 * 解析 image.progress 事件为 0..100 的整数百分比，并保证不低于 prev（防乱序回退）。
 * 算法 (done + percent/100) / total；没有 percent 按 done/total；兼容缺 phase 的旧事件。
 * 事件不合格时返回 prev。
 *
 * @param data 事件 data：{ done, total, phase?, percent? }
 * @param prev 之前显示的百分比
 */
export function stitchPercent(data: unknown, prev: number): number {
  const d = data as { done?: unknown; total?: unknown; percent?: unknown } | null
  if (!d || typeof d.done !== 'number' || typeof d.total !== 'number' || d.total <= 0) return prev
  const part = typeof d.percent === 'number' ? Math.min(PERCENT_FULL, Math.max(0, d.percent)) / PERCENT_FULL : 0
  const frac = Math.min(1, Math.max(0, (d.done + part) / d.total))
  return Math.max(prev, Math.floor(frac * PERCENT_FULL))
}
