/**
 * 视频与音频封装：选视频、读信息、提取音频、取帧、压缩。
 * 对应原生 `native.media.*`，契约见 docs/design/bridge-protocol.md「视频与音频方法」。
 *
 * 原生只用平台自带的 MediaExtractor / MediaMuxer / MediaCodec / MediaMetadataRetriever，
 * 以后可换成 Media3 Transformer，页面侧接口不变。无宿主时全部抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall, on as bridgeOn } from './bridge'
import { requireNative, type CallFn } from './system'
import type { OnFn } from './tts'

/** 方法名常量 */
export const MEDIA_METHODS = {
  pick: 'native.file.pick',
  info: 'native.media.info',
  extractAudio: 'native.media.extractAudio',
  frames: 'native.media.frames',
  compress: 'native.media.compress',
  save: 'native.file.save',
} as const

/** 进度事件名 */
export const MEDIA_EVENT_PROGRESS = 'media.progress'

/** 选视频的 mime 过滤 */
export const VIDEO_MIME = 'video/*'

/** 压缩预设 */
export type CompressPreset = 'high' | 'medium' | 'low'

/** 选中的视频：句柄只能交给原生方法用，页面拿不到真实路径 */
export interface PickedVideo {
  /** 不透明句柄 `uri:<id>`，随会话失效 */
  handle: string
  /** 文件名 */
  name: string
  /** 字节数 */
  size: number
  /** 时长（毫秒），读不到为 undefined */
  durationMs?: number
  /** 宽（已按旋转摆正） */
  width?: number
  /** 高（已按旋转摆正） */
  height?: number
}

/** 视频信息，读不到的字段为 null */
export interface MediaInfo {
  /** 时长（毫秒） */
  durationMs: number | null
  /** 宽（已按旋转摆正） */
  width: number | null
  /** 高（已按旋转摆正） */
  height: number | null
  /** 旋转角 0/90/180/270 */
  rotation: number
  /** 容器总码率（bps） */
  bitrate: number | null
  /** 文件体积 */
  sizeBytes: number | null
  /** 是否有音轨 */
  hasAudio: boolean
  /** 视频编码 mime */
  videoMime: string | null
  /** 音频编码 mime */
  audioMime: string | null
  /** 帧率 */
  fps: number | null
}

/** 提取音频的结果 */
export interface ExtractedAudio {
  /** 缓存相对路径，如 `cache/out/audio-xxxx/旅行.m4a` */
  path: string
  /** 文件名 */
  name: string
  /** mime，固定 `audio/mp4` */
  mime: string
  /** 字节数 */
  bytes: number
  /** 音频时长（毫秒） */
  durationMs: number
}

/** 取帧参数 */
export interface FramesOptions {
  /** 起点（毫秒），缺省 0 */
  startMs?: number
  /** 时长（毫秒），缺省 3000，最大 15000 */
  durationMs?: number
  /** 帧率 1~15，缺省 8 */
  fps?: number
  /** 最大边（像素），缺省 320，最大 480 */
  maxEdge?: number
}

/** 取帧结果 */
export interface FramesResult {
  /** 帧列表，按时间排序 */
  frames: Array<{ path: string; timeMs: number }>
  /** 单帧宽 */
  width: number
  /** 单帧高 */
  height: number
}

/** 压缩结果 */
export interface CompressResult {
  /** 缓存相对路径 */
  path: string
  /** 文件名 */
  name: string
  /** 产物字节数 */
  bytes: number
  /** 源字节数 */
  srcBytes: number
  /** 产物 / 源，>= 1 表示没压小 */
  ratio: number
  /** 时长（毫秒） */
  durationMs: number
  /** 没压小时的原生说明 */
  message?: string
}

/** 进度：已处理毫秒 / 总毫秒（取帧时为 已取帧数 / 总帧数） */
export interface MediaProgress {
  /** 已完成量 */
  done: number
  /** 总量 */
  total: number
}

/** 长任务的额外参数 */
export interface LongExtra {
  /** 取消信号 */
  signal?: AbortSignal
  /** 进度回调 */
  onProgress?: (p: MediaProgress) => void
}

/** 带取消信号的调用选项：长任务不设超时 */
function longOptions(signal?: AbortSignal): { timeoutMs?: number } {
  return { timeoutMs: 0, signal } as { timeoutMs?: number }
}

/**
 * 订阅 `media.progress` 事件。
 *
 * @param handler 进度回调
 * @param on 事件订阅函数，默认走 bridge（仅测试注入）
 * @returns 取消订阅函数
 * @example const off = onMediaProgress((p) => console.log(p.done / p.total))
 */
export function onMediaProgress(handler: (p: MediaProgress) => void, on: OnFn = bridgeOn): () => void {
  return on(MEDIA_EVENT_PROGRESS, (d) => {
    const p = d as Partial<MediaProgress> | null
    if (p && typeof p.done === 'number' && typeof p.total === 'number') handler({ done: p.done, total: p.total })
  })
}

/** 执行一次带进度订阅的长调用，结束必退订 */
async function withProgress<T>(run: () => Promise<T>, extra: LongExtra, on: OnFn): Promise<T> {
  const off = extra.onProgress ? onMediaProgress(extra.onProgress, on) : null
  try {
    return await run()
  } finally {
    off?.()
  }
}

/**
 * 弹出系统选择器选一个视频。不拷贝文件，只拿到句柄与基本信息。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 选中的视频；用户取消返回 null
 * @throws 选中的文件处理失败时抛带原生提示的 Error
 * @example const v = await pickVideo(); if (v) console.log(v.name)
 */
export async function pickVideo(call: CallFn = bridgeCall): Promise<PickedVideo | null> {
  requireNative(MEDIA_METHODS.pick)
  const res = await call<{ items: Array<Record<string, unknown>>; failed?: Array<{ name: string; message: string }> }>(
    MEDIA_METHODS.pick,
    { mime: VIDEO_MIME, multiple: false, max: 1 },
    { timeoutMs: 0 },
  )
  const it = res.items.find((i) => i.kind === 'video')
  if (!it) {
    if (res.failed?.length) throw new Error(res.failed[0].message)
    return null
  }
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  return {
    handle: String(it.handle),
    name: String(it.name ?? ''),
    size: num(it.size) ?? 0,
    durationMs: num(it.durationMs),
    width: num(it.width),
    height: num(it.height),
  }
}

/**
 * 读视频信息，读不到的字段为 null。
 *
 * @param handle 视频句柄
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 视频信息
 * @example const info = await mediaInfo(v.handle)
 */
export async function mediaInfo(handle: string, call: CallFn = bridgeCall): Promise<MediaInfo> {
  requireNative(MEDIA_METHODS.info)
  return call<MediaInfo>(MEDIA_METHODS.info, { handle })
}

/**
 * 提取音轨存成 .m4a。只支持 AAC 直通，其他编码会以 BAD_PARAMS 拒绝（message 是中文说明）。可取消，带进度。
 *
 * @param handle 视频句柄
 * @param range 起止毫秒，都可省；缺省取整段
 * @param extra 取消信号与进度回调
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param on 事件订阅函数，默认走 bridge（仅测试注入）
 * @returns 产物信息
 * @example const a = await extractAudio(v.handle, { startMs: 1000, endMs: 9000 })
 */
export async function extractAudio(
  handle: string,
  range: { startMs?: number; endMs?: number } = {},
  extra: LongExtra = {},
  call: CallFn = bridgeCall,
  on: OnFn = bridgeOn,
): Promise<ExtractedAudio> {
  requireNative(MEDIA_METHODS.extractAudio)
  const params: Record<string, unknown> = { handle }
  if (range.startMs !== undefined) params.startMs = range.startMs
  if (range.endMs !== undefined) params.endMs = range.endMs
  return withProgress(() => call<ExtractedAudio>(MEDIA_METHODS.extractAudio, params, longOptions(extra.signal)), extra, on)
}

/**
 * 按帧率从视频取一批 JPEG 帧，供 GIF 编码。可取消，进度为 已取帧数 / 总帧数。
 *
 * @param handle 视频句柄
 * @param options 取帧参数，值为 undefined 的项不传
 * @param extra 取消信号与进度回调
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param on 事件订阅函数，默认走 bridge（仅测试注入）
 * @returns 帧路径与尺寸
 * @example const r = await extractFrames(v.handle, { startMs: 0, durationMs: 3000, fps: 8, maxEdge: 320 })
 */
export async function extractFrames(
  handle: string,
  options: FramesOptions = {},
  extra: LongExtra = {},
  call: CallFn = bridgeCall,
  on: OnFn = bridgeOn,
): Promise<FramesResult> {
  requireNative(MEDIA_METHODS.frames)
  const params: Record<string, unknown> = { handle }
  if (options.startMs !== undefined) params.startMs = options.startMs
  if (options.durationMs !== undefined) params.durationMs = options.durationMs
  if (options.fps !== undefined) params.fps = options.fps
  if (options.maxEdge !== undefined) params.maxEdge = options.maxEdge
  return withProgress(() => call<FramesResult>(MEDIA_METHODS.frames, params, longOptions(extra.signal)), extra, on)
}

/**
 * 压缩视频：只降码率，不缩放分辨率，音轨直通。可取消，带进度。
 * `ratio >= 1` 表示没压小（结果里带 `message`）。
 *
 * @param handle 视频句柄
 * @param preset 预设：high / medium / low
 * @param extra 取消信号与进度回调
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param on 事件订阅函数，默认走 bridge（仅测试注入）
 * @returns 产物信息
 * @example const r = await compressVideo(v.handle, 'medium', { onProgress: (p) => (pct = p.done / p.total) })
 */
export async function compressVideo(
  handle: string,
  preset: CompressPreset,
  extra: LongExtra = {},
  call: CallFn = bridgeCall,
  on: OnFn = bridgeOn,
): Promise<CompressResult> {
  requireNative(MEDIA_METHODS.compress)
  return withProgress(() => call<CompressResult>(MEDIA_METHODS.compress, { handle, preset }, longOptions(extra.signal)), extra, on)
}

/** 缓存文件存进公共目录的结果 */
export interface SavedFile {
  /** 保存后的 content URI */
  uri: string
  /** 实际文件名（重名时系统可能改名） */
  name: string
  /** 字节数 */
  size: number
  /** 公共目录，如 `Music/Arkli` */
  dir: string
}

/**
 * 把原生已经写好的缓存文件（如提取的音频、压缩后的视频）存进公共目录，不经过页面内存。
 * 音频进 `Music/Arkli`，视频进 `Movies/Arkli`。
 *
 * @param path 缓存相对路径，如 `cache/out/video-ab/a.mp4`
 * @param name 保存用的文件名
 * @param mime 内容类型，决定保存目录
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 保存结果
 * @example await saveCachedFile(r.path, r.name, 'video/mp4')
 */
export async function saveCachedFile(path: string, name: string, mime: string, call: CallFn = bridgeCall): Promise<SavedFile> {
  requireNative(MEDIA_METHODS.save)
  const res = await call<{ items: SavedFile[] }>(MEDIA_METHODS.save, { items: [{ path, name, mime }] }, { timeoutMs: 0 })
  return res.items[0]
}
