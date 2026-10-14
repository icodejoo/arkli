/**
 * 视频压缩的纯逻辑：三档预设、目标码率与预计体积（与原生同一套公式）、前后对比文案、音轨可压缩判断。
 */
import type { CompressPreset, CompressResult, MediaInfo } from '@/native/media'

/** 码率下限（bps），与原生一致 */
export const MIN_BITRATE_BPS = 300_000
/** 源码率读不到时扣掉的音频码率（bps） */
export const ASSUMED_AUDIO_BPS = 128_000
/** 一字节的位数 */
const BITS_PER_BYTE = 8
/** 毫秒每秒 */
const MS_PER_SEC = 1000
/** 百分制 */
const PERCENT = 100
/** 能直通保留的音轨编码：AAC 与 AMR（原生写入 mp4 容器） */
export const PASSTHROUGH_AUDIO_MIMES = ['audio/mp4a-latm', 'audio/3gpp', 'audio/amr-wb']

/** 一档预设 */
export interface PresetOption {
  /** 传给原生的预设名 */
  key: CompressPreset
  /** 显示名 */
  name: string
  /** 说明 */
  hint: string
  /** 码率系数，与原生一致 */
  factor: number
}

/** 三档预设：高质量 / 均衡 / 小体积 */
export const PRESETS: PresetOption[] = [
  { key: 'high', name: '高质量', hint: '码率约保留 70%，画质几乎看不出差别', factor: 0.7 },
  { key: 'medium', name: '均衡', hint: '码率约保留 50%，推荐', factor: 0.5 },
  { key: 'low', name: '小体积', hint: '码率约保留 30%，体积最小，细节会变糊', factor: 0.3 },
]

/**
 * 按预设名取预设。
 *
 * @param key 预设名
 * @returns 预设；找不到取均衡
 */
export function presetOf(key: CompressPreset): PresetOption {
  return PRESETS.find((p) => p.key === key) ?? PRESETS[1]
}

/**
 * 目标视频码率：源码率 × 系数，不低于 300kbps，但不超过源码率。
 *
 * @param srcBps 源视频码率
 * @param preset 预设名
 * @returns 目标码率（bps）
 * @example targetBitrate(4_000_000, 'medium') // 2000000
 */
export function targetBitrate(srcBps: number, preset: CompressPreset): number {
  const scaled = Math.round(srcBps * presetOf(preset).factor)
  return Math.min(srcBps, Math.max(MIN_BITRATE_BPS, scaled))
}

/**
 * 估算源视频码率：总码率扣掉音频；总码率读不到时用体积除时长。
 *
 * @param info 视频信息
 * @returns bps；信息不足返回 null
 */
export function sourceVideoBitrate(info: Pick<MediaInfo, 'bitrate' | 'sizeBytes' | 'durationMs' | 'hasAudio'>): number | null {
  const audio = info.hasAudio ? ASSUMED_AUDIO_BPS : 0
  let total: number | null = null
  if (info.bitrate && info.bitrate > 0) total = info.bitrate
  else if (info.sizeBytes && info.sizeBytes > 0 && info.durationMs && info.durationMs > 0) {
    total = Math.floor((info.sizeBytes * BITS_PER_BYTE * MS_PER_SEC) / info.durationMs)
  }
  return total === null ? null : Math.max(MIN_BITRATE_BPS, total - audio)
}

/**
 * 预计压缩后体积：（目标视频码率 + 音频码率）× 时长。
 *
 * @param info 视频信息
 * @param preset 预设名
 * @returns 字节数；信息不足返回 null
 * @example estimateBytes({ bitrate: 4_128_000, sizeBytes: 0, durationMs: 10_000, hasAudio: true }, 'medium') // 2660000
 */
export function estimateBytes(info: Pick<MediaInfo, 'bitrate' | 'sizeBytes' | 'durationMs' | 'hasAudio'>, preset: CompressPreset): number | null {
  const src = sourceVideoBitrate(info)
  if (src === null || !info.durationMs || info.durationMs <= 0) return null
  const audio = info.hasAudio ? ASSUMED_AUDIO_BPS : 0
  return Math.round(((targetBitrate(src, preset) + audio) * info.durationMs) / MS_PER_SEC / BITS_PER_BYTE)
}

/**
 * 音轨能不能随压缩一起保留（原生直通写入，不重编码）。
 *
 * @param info 视频信息
 * @returns 能压缩返回 `{ ok: true }`；音轨编码不支持时带说明
 */
export function checkAudioKept(info: Pick<MediaInfo, 'hasAudio' | 'audioMime'>): { ok: boolean; text: string } {
  if (!info.hasAudio || info.audioMime === null || PASSTHROUGH_AUDIO_MIMES.includes(info.audioMime)) return { ok: true, text: '' }
  return { ok: false, text: `音轨编码为 ${info.audioMime.replace(/^audio\//, '')}，当前版本无法保留，暂不能压缩这个视频` }
}

/**
 * 压缩比文案：变小为 `-62%`，变大为 `+5%`。
 *
 * @param srcBytes 源体积
 * @param outBytes 产物体积
 * @returns 百分比文案；源体积未知返回 `--`
 */
export function changeText(srcBytes: number, outBytes: number): string {
  if (!(srcBytes > 0)) return '--'
  const pct = Math.round(((outBytes - srcBytes) / srcBytes) * PERCENT)
  if (pct === 0) return '0%'
  return pct > 0 ? `+${pct}%` : `${pct}%`
}

/**
 * 结果是否没有变小（含刚好持平）。
 *
 * @param r 压缩结果
 * @returns 没变小返回 true
 */
export function isNotSmaller(r: Pick<CompressResult, 'ratio' | 'bytes' | 'srcBytes'>): boolean {
  if (r.srcBytes > 0) return r.bytes >= r.srcBytes
  return r.ratio >= 1
}

/** 没变小时页面的提示语 */
export const NOT_SMALLER_TEXT = '这个视频已经压得很小了，压缩后反而没有变小，建议保留原视频，不必保存新文件。'

/**
 * 输入检查：预估体积不小于源体积时提前告知。
 *
 * @param estimate 预计体积，null 表示未知
 * @param srcBytes 源体积
 * @returns 提示语；没有问题为空串
 */
export function preWarning(estimate: number | null, srcBytes: number): string {
  if (estimate !== null && srcBytes > 0 && estimate >= srcBytes) return '按这个预设预计压不小，视频可能本来码率就不高。'
  return ''
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
