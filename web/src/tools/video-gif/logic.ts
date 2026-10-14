/**
 * 视频转 GIF 的纯逻辑：参数夹取、帧数与尺寸换算、体积预估与合理性提示、两阶段进度、文件名与取帧地址。
 */

/** 原生缓存路径在页面里的同源前缀 */
export const FILES_URL_PREFIX = '/files/'
/** 取帧时长上限（毫秒），与原生一致 */
export const MAX_DURATION_MS = 15_000
/** 取帧时长下限（毫秒） */
export const MIN_DURATION_MS = 500
/** 帧率下限 */
export const FPS_MIN = 5
/** 帧率上限 */
export const FPS_MAX = 15
/** 缺省帧率 */
export const DEFAULT_FPS = 8
/** 缺省时长（毫秒） */
export const DEFAULT_DURATION_MS = 3000
/** 可选最大边（像素） */
export const EDGE_OPTIONS = [160, 240, 320, 480] as const
/** 缺省最大边 */
export const DEFAULT_EDGE = 320
/** 总帧数上限，与原生一致 */
export const MAX_FRAMES = 150
/** GIF 每像素的经验字节数：256 色 LZW 压视频画面大约 0.5 字节 */
export const GIF_BYTES_PER_PIXEL = 0.5
/** 体积提示线：超过这个值提醒偏大（字节） */
export const WARN_GIF_BYTES = 8 * 1024 * 1024
/** 帧数提示线 */
export const WARN_FRAMES = 100
/** 毫秒每秒 */
const MS_PER_SEC = 1000
/** 百分制 */
const PERCENT = 100
/** GIF 延迟单位：1/100 秒 */
const CS_PER_SEC = 100
/** 单帧最短延迟（1/100 秒），再短多数播放器会按 10 处理 */
const MIN_DELAY_CS = 2
/** 取帧阶段占总进度的比例（百分点），其余给编码阶段 */
export const CAPTURE_SHARE = 40
/** 产物扩展名 */
const GIF_EXT = '.gif'
/** 缺省产物名主体 */
const DEFAULT_BASE = 'video'

/** 两个阶段 */
export type GifStage = 'capture' | 'encode'

/** 一份转换方案 */
export interface GifPlan {
  /** 帧数 */
  frames: number
  /** 单帧宽 */
  width: number
  /** 单帧高 */
  height: number
  /** 预估体积（字节） */
  bytes: number
}

/**
 * 夹取时长：不小于 0.5 秒、不大于 15 秒，也不能超出起点之后剩余的视频长度。
 *
 * @param startMs 起点（毫秒）
 * @param durationMs 想要的时长
 * @param totalMs 视频总时长
 * @returns 合法时长（毫秒）；视频本身短于 0.5 秒时取视频剩余长度
 * @example clampDuration(8000, 9000, 10_000) // 2000
 */
export function clampDuration(startMs: number, durationMs: number, totalMs: number): number {
  const left = Math.max(0, totalMs - startMs)
  const want = Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, durationMs))
  return Math.min(want, left)
}

/**
 * 起点滑杆的最大值：保证从这里开始还能取到完整时长（视频比时长短时为 0）。
 *
 * @param totalMs 视频总时长
 * @param durationMs 取帧时长
 * @returns 起点上限（毫秒）
 */
export function maxStartMs(totalMs: number, durationMs: number): number {
  return Math.max(0, totalMs - durationMs)
}

/**
 * 按最大边缩小，不放大，保持比例；与原生算法一致。
 *
 * @param width 源宽
 * @param height 源高
 * @param maxEdge 最大边
 * @returns 缩放后的宽高
 * @example scaleSize(1920, 1080, 320) // { width: 320, height: 180 }
 */
export function scaleSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest <= 0) return { width, height }
  const k = maxEdge / longest
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/**
 * 取帧数：与原生时间表一致，间隔 `1000/fps` 毫秒，到时长或视频结尾为止，最多 150。
 *
 * @param startMs 起点
 * @param durationMs 时长
 * @param fps 帧率
 * @param totalMs 视频总时长
 * @returns 帧数
 * @example frameCount(0, 3000, 8, 10_000) // 24
 */
export function frameCount(startMs: number, durationMs: number, fps: number, totalMs: number): number {
  const end = Math.min(startMs + durationMs, totalMs)
  let n = 0
  while (n < MAX_FRAMES && startMs + Math.floor((n * MS_PER_SEC) / fps) < end) n++
  return n
}

/**
 * 每帧延迟（1/100 秒）。
 *
 * @param fps 帧率
 * @returns 延迟，不小于 2
 * @example delayCs(10) // 10
 */
export function delayCs(fps: number): number {
  return Math.max(MIN_DELAY_CS, Math.round(CS_PER_SEC / fps))
}

/**
 * 预估 GIF 体积（经验值，误差可能在一倍上下）。
 *
 * @param frames 帧数
 * @param width 帧宽
 * @param height 帧高
 * @returns 字节数
 */
export function estimateGifBytes(frames: number, width: number, height: number): number {
  return Math.round(frames * width * height * GIF_BYTES_PER_PIXEL)
}

/**
 * 生成方案：帧数、尺寸、预估体积。
 *
 * @param opts 起点、时长、帧率、最大边、视频总时长与源尺寸
 * @returns 方案
 */
export function makePlan(opts: {
  startMs: number
  durationMs: number
  fps: number
  maxEdge: number
  totalMs: number
  srcWidth: number
  srcHeight: number
}): GifPlan {
  const { width, height } = scaleSize(opts.srcWidth, opts.srcHeight, opts.maxEdge)
  const frames = frameCount(opts.startMs, opts.durationMs, opts.fps, opts.totalMs)
  return { frames, width, height, bytes: estimateGifBytes(frames, width, height) }
}

/**
 * 参数合理性提示。
 *
 * @param plan 方案
 * @returns 提示语列表，没问题为空数组
 */
export function adviceFor(plan: GifPlan): string[] {
  const tips: string[] = []
  if (plan.frames === 0) {
    tips.push('起点已经超出视频长度，取不到画面')
    return tips
  }
  if (plan.bytes > WARN_GIF_BYTES) tips.push('预计体积偏大，建议缩短时长、降低帧率或减小尺寸')
  if (plan.frames >= WARN_FRAMES) tips.push(`帧数较多（${plan.frames} 帧），转换会比较慢`)
  if (plan.frames >= MAX_FRAMES) tips.push(`单次最多取 ${MAX_FRAMES} 帧，超出的部分会被截掉`)
  return tips
}

/**
 * 综合进度：取帧占前 40%，编码占后 60%。
 *
 * @param stage 当前阶段
 * @param done 本阶段已完成数
 * @param total 本阶段总数
 * @returns 0~100 的整数
 */
export function overallPercent(stage: GifStage, done: number, total: number): number {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0
  const v = stage === 'capture' ? ratio * CAPTURE_SHARE : CAPTURE_SHARE + ratio * (PERCENT - CAPTURE_SHARE)
  return Math.round(v)
}

/**
 * 产物文件名：视频名主体 + `.gif`。
 *
 * @param videoName 视频文件名
 * @returns 如 `旅行.mp4` -> `旅行.gif`
 */
export function gifFileName(videoName: string): string {
  const clean = videoName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  const dot = clean.lastIndexOf('.')
  const base = (dot > 0 ? clean.slice(0, dot) : clean).trim()
  return (base || DEFAULT_BASE) + GIF_EXT
}

/**
 * 缓存相对路径换成页面可 fetch 的同源地址。
 *
 * @param path 如 `cache/out/frames-ab/f000.jpg`
 * @returns 如 `/files/cache/out/frames-ab/f000.jpg`
 */
export function frameUrl(path: string): string {
  return FILES_URL_PREFIX + path.replace(/^\/+/, '')
}

/**
 * 取错误文字。
 *
 * @param e 异常
 * @param fallback 没有 message 时的兜底
 * @returns 错误文字
 */
export function msgOf(e: unknown, fallback: string): string {
  return (e as { message?: string } | null)?.message || fallback
}

/**
 * 是否用户取消。
 *
 * @param e 异常
 * @returns 是取消返回 true
 */
export function isCancelled(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'CANCELLED'
}
