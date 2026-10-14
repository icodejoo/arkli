/**
 * 视频提取音频的纯逻辑：时长格式化、起止时间换算与校验、音轨支持判断、进度与错误文案。
 */
import type { MediaInfo, MediaProgress } from '@/native/media'

/** 毫秒每秒 */
export const MS_PER_SEC = 1000
/** 秒每分、分每小时 */
const SEC_PER_MIN = 60
/** 时间补零宽度 */
const PAD = 2
/** 起止时间至少相隔多少毫秒 */
export const MIN_SPAN_MS = 100
/** 总时长不超过它时滑杆步长为 100ms，否则 1 秒 */
const FINE_STEP_LIMIT_MS = 10 * SEC_PER_MIN * MS_PER_SEC
/** 细步长（毫秒） */
const FINE_STEP_MS = 100
/** 粗步长（毫秒） */
const COARSE_STEP_MS = 1000
/** 唯一支持直通提取的音频编码 */
export const SUPPORTED_AUDIO_MIME = 'audio/mp4a-latm'
/** 提取产物的 mime */
export const AUDIO_OUT_MIME = 'audio/mp4'
/** 百分比换算 */
const PERCENT = 100

/** 起止区间（毫秒） */
export interface Range {
  /** 起点 */
  startMs: number
  /** 终点 */
  endMs: number
}

/**
 * 毫秒格式化成 `m:ss` 或 `h:mm:ss`；负数与非数字按 0 处理。
 *
 * @param ms 毫秒
 * @returns 如 `1:05`、`1:02:03`
 * @example formatDuration(65_000) // '1:05'
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / MS_PER_SEC) : 0
  const h = Math.floor(total / (SEC_PER_MIN * SEC_PER_MIN))
  const m = Math.floor(total / SEC_PER_MIN) % SEC_PER_MIN
  const s = total % SEC_PER_MIN
  const pad = (n: number) => String(n).padStart(PAD, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * 滑杆步长：短视频精确到 100ms，长视频 1 秒。
 *
 * @param totalMs 视频总时长
 * @returns 步长（毫秒）
 */
export function sliderStep(totalMs: number): number {
  return totalMs <= FINE_STEP_LIMIT_MS ? FINE_STEP_MS : COARSE_STEP_MS
}

/**
 * 把滑杆给出的区间规整到 0~总时长，并保证起止至少相隔 {@link MIN_SPAN_MS}。
 *
 * @param range 滑杆值 [起, 止]
 * @param totalMs 视频总时长
 * @returns 规整后的区间
 * @example normalizeRange([8000, 3000], 10000) // { startMs: 3000, endMs: 8000 }
 */
export function normalizeRange(range: [number, number], totalMs: number): Range {
  const total = Math.max(0, totalMs)
  let a = Math.min(Math.max(0, Math.min(range[0], range[1])), total)
  let b = Math.min(Math.max(0, Math.max(range[0], range[1])), total)
  if (b - a < MIN_SPAN_MS) {
    if (total >= MIN_SPAN_MS) {
      if (a + MIN_SPAN_MS <= total) b = a + MIN_SPAN_MS
      else a = b - MIN_SPAN_MS
    } else {
      a = 0
      b = total
    }
  }
  return { startMs: a, endMs: b }
}

/**
 * 区间是否就是整段。
 *
 * @param r 区间
 * @param totalMs 总时长
 * @returns 是整段返回 true
 */
export function isWhole(r: Range, totalMs: number): boolean {
  return r.startMs <= 0 && r.endMs >= totalMs
}

/**
 * 生成给原生的请求区间：整段时都不传，只裁一头时只传那一头。
 *
 * @param r 区间
 * @param totalMs 总时长
 * @returns 可直接传给 extractAudio 的起止
 * @example toRequest({ startMs: 0, endMs: 5000 }, 10000) // { endMs: 5000 }
 */
export function toRequest(r: Range, totalMs: number): { startMs?: number; endMs?: number } {
  const out: { startMs?: number; endMs?: number } = {}
  if (r.startMs > 0) out.startMs = Math.round(r.startMs)
  if (r.endMs < totalMs) out.endMs = Math.round(r.endMs)
  return out
}

/**
 * 区间文案。
 *
 * @param r 区间
 * @returns 如 `0:03 – 0:08（共 0:05）`
 */
export function rangeLabel(r: Range): string {
  return `${formatDuration(r.startMs)} – ${formatDuration(r.endMs)}（共 ${formatDuration(r.endMs - r.startMs)}）`
}

/** 音轨检查结果 */
export interface AudioCheck {
  /** 能否提取 */
  ok: boolean
  /** 给用户的说明 */
  text: string
}

/**
 * 音频编码的短名。
 *
 * @param mime 音频 mime，可为 null
 * @returns 如 `AAC`；不认识的去掉 `audio/` 前缀
 */
export function audioCodecName(mime: string | null): string {
  if (mime === null) return '未知编码'
  if (mime === SUPPORTED_AUDIO_MIME) return 'AAC'
  return mime.replace(/^audio\//, '')
}

/**
 * 判断一个视频的音轨能不能直接提取。
 *
 * @param info 视频信息
 * @returns 能不能提取与说明
 * @example checkAudio({ hasAudio: false, audioMime: null }) // { ok: false, text: '这个视频没有音轨' }
 */
export function checkAudio(info: Pick<MediaInfo, 'hasAudio' | 'audioMime'>): AudioCheck {
  if (!info.hasAudio) return { ok: false, text: '这个视频没有音轨' }
  if (info.audioMime === null || info.audioMime === SUPPORTED_AUDIO_MIME) return { ok: true, text: audioCodecName(info.audioMime) }
  return { ok: false, text: `音轨编码为 ${audioCodecName(info.audioMime)}，暂不支持直接提取（目前只支持 AAC）` }
}

/**
 * 进度百分比，夹在 0~100。
 *
 * @param p 原生进度
 * @returns 整数百分比
 */
export function percentOf(p: MediaProgress): number {
  if (!(p.total > 0)) return 0
  return Math.min(PERCENT, Math.max(0, Math.round((p.done / p.total) * PERCENT)))
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
