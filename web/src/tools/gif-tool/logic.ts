/** GIF 合成/分解的纯计算：尺寸、延迟换算、帧数校验、帧排布。不碰 DOM，方便单测。 */
import { fitMaxEdge, type Size } from '@/shared/image-calc'

/** 合成时最多帧数 */
export const MAX_COMPOSE_FRAMES = 60
/** 分解时最多处理帧数（再多会占掉太多内存） */
export const MAX_DECOMPOSE_FRAMES = 300
/** 合成画面长边默认上限（像素） */
export const DEFAULT_MAX_EDGE = 480
/** 合成画面长边可调下限（像素） */
export const MIN_MAX_EDGE = 64
/** GIF 延迟单位：1/100 秒，对应毫秒数 */
export const MS_PER_CS = 10
/** 延迟最小值（1/100 秒）：浏览器会把 0~1 当成 10，直接按 2 起步避免异常变慢 */
export const MIN_DELAY_CS = 2
/** 延迟最大值（16 位） */
export const MAX_DELAY_CS = 65535
/** 默认每帧延迟（毫秒） */
export const DEFAULT_DELAY_MS = 200
/** 浏览器对 0~1 厘秒延迟的实际取值（厘秒） */
const BROWSER_FALLBACK_CS = 10
/** 毫秒每秒 */
const MS_PER_SECOND = 1000

/** 统一尺寸方式：适应（留边）、填充（裁切）、拉伸 */
export type FitMode = 'contain' | 'cover' | 'stretch'

/** 播放顺序 */
export type PlayOrder = 'normal' | 'reverse' | 'pingpong'

/** 一帧的绘制参数：从源图取 (sx,sy,sw,sh)，画到画布 (dx,dy,dw,dh) */
export interface Placement {
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
}

/** 帧数校验结果 */
export interface FrameCheck {
  /** 是否在上限内 */
  ok: boolean
  /** 超出的帧数，没超为 0 */
  over: number
}

/**
 * 毫秒换算成 GIF 延迟（1/100 秒），四舍五入并限制在 [MIN_DELAY_CS, MAX_DELAY_CS]。
 *
 * @param ms 毫秒
 * @returns 厘秒
 * @example msToCs(200) // 20
 */
export function msToCs(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_DELAY_CS
  return Math.max(MIN_DELAY_CS, Math.min(MAX_DELAY_CS, Math.round(ms / MS_PER_CS)))
}

/**
 * GIF 延迟换算成毫秒；0~1 厘秒按浏览器实际行为当作 10 厘秒。
 *
 * @param cs 厘秒
 * @returns 实际播放毫秒
 * @example csToMs(0) // 100
 */
export function csToMs(cs: number): number {
  return (cs < MIN_DELAY_CS ? BROWSER_FALLBACK_CS : cs) * MS_PER_CS
}

/**
 * 校验帧数是否在上限内。
 *
 * @param count 帧数
 * @param max 上限，默认 MAX_COMPOSE_FRAMES
 * @returns ok 与超出数量
 * @example checkFrameCount(65) // { ok: false, over: 5 }
 */
export function checkFrameCount(count: number, max = MAX_COMPOSE_FRAMES): FrameCheck {
  const over = Math.max(0, count - max)
  return { ok: over === 0, over }
}

/**
 * 限制长边上限到允许范围 [MIN_MAX_EDGE, DEFAULT_MAX_EDGE]。
 *
 * @param v 用户给的值
 * @returns 合法的长边上限，非数字回到默认
 */
export function clampMaxEdge(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_MAX_EDGE
  return Math.max(MIN_MAX_EDGE, Math.min(DEFAULT_MAX_EDGE, Math.round(v)))
}

/**
 * 合成画面尺寸：以第一张图的宽高比为准，长边不超过 maxEdge（只缩不放）。
 *
 * @param sizes 各图原始尺寸（按顺序）
 * @param maxEdge 长边上限
 * @returns 画面尺寸；没有图时为 0x0
 * @example canvasSize([{ width: 1000, height: 500 }], 480) // { width: 480, height: 240 }
 */
export function canvasSize(sizes: Size[], maxEdge: number): Size {
  const first = sizes.find((s) => s.width > 0 && s.height > 0)
  if (!first) return { width: 0, height: 0 }
  const { width, height } = fitMaxEdge(first.width, first.height, clampMaxEdge(maxEdge))
  return { width, height }
}

/**
 * 计算一张图画进统一画布的方式。
 *
 * @param src 源图尺寸
 * @param canvas 画布尺寸
 * @param mode contain 完整显示留边；cover 铺满并裁掉多余；stretch 拉伸变形
 * @returns 源裁切区与目标区
 * @example placeFrame({ width: 200, height: 100 }, { width: 100, height: 100 }, 'contain')
 * // { sx:0, sy:0, sw:200, sh:100, dx:0, dy:25, dw:100, dh:50 }
 */
export function placeFrame(src: Size, canvas: Size, mode: FitMode): Placement {
  const full: Placement = { sx: 0, sy: 0, sw: src.width, sh: src.height, dx: 0, dy: 0, dw: canvas.width, dh: canvas.height }
  if (mode === 'stretch' || src.width <= 0 || src.height <= 0) return full
  const scale =
    mode === 'contain' ? Math.min(canvas.width / src.width, canvas.height / src.height) : Math.max(canvas.width / src.width, canvas.height / src.height)
  if (mode === 'contain') {
    const dw = Math.max(1, Math.round(src.width * scale))
    const dh = Math.max(1, Math.round(src.height * scale))
    return { ...full, dx: Math.round((canvas.width - dw) / 2), dy: Math.round((canvas.height - dh) / 2), dw, dh }
  }
  // cover：在源图上按画布比例取中间一块
  const sw = Math.min(src.width, canvas.width / scale)
  const sh = Math.min(src.height, canvas.height / scale)
  return { ...full, sx: (src.width - sw) / 2, sy: (src.height - sh) / 2, sw, sh }
}

/**
 * 按播放顺序给出帧下标序列。pingpong 为 0..n-1 再回到 n-2..1（首尾不重复）。
 *
 * @param count 图片张数
 * @param order 播放顺序
 * @returns 帧下标序列
 * @example playIndices(4, 'pingpong') // [0, 1, 2, 3, 2, 1]
 */
export function playIndices(count: number, order: PlayOrder): number[] {
  const fwd = Array.from({ length: Math.max(0, count) }, (_, i) => i)
  if (order === 'reverse') return fwd.reverse()
  if (order === 'pingpong' && count > 2) return fwd.concat(fwd.slice(1, -1).reverse())
  return fwd
}

/**
 * 得到每帧的延迟（厘秒）。统一模式用同一个毫秒值；逐帧模式取各自的值，缺省回落到统一值。
 *
 * @param count 帧数
 * @param uniformMs 统一延迟（毫秒）
 * @param perFrameMs 逐帧延迟（毫秒），按帧下标对应；undefined 表示用统一值
 * @returns 每帧延迟（厘秒）
 * @example resolveDelays(3, 100, [undefined, 500]) // [10, 50, 10]
 */
export function resolveDelays(count: number, uniformMs: number, perFrameMs?: Array<number | undefined>): number[] {
  return Array.from({ length: count }, (_, i) => msToCs(perFrameMs?.[i] ?? uniformMs))
}

/**
 * 总时长（毫秒），每帧按浏览器实际行为换算。
 *
 * @param delaysCs 各帧延迟（厘秒）
 * @returns 总毫秒数
 * @example totalDurationMs([10, 20]) // 300
 */
export function totalDurationMs(delaysCs: number[]): number {
  return delaysCs.reduce((s, d) => s + csToMs(d), 0)
}

/**
 * 毫秒格式化成「1.25 秒」。
 *
 * @param ms 毫秒
 * @returns 文案
 * @example formatSeconds(1250) // '1.25 秒'
 */
export function formatSeconds(ms: number): string {
  return `${(ms / MS_PER_SECOND).toFixed(2)} 秒`
}

/**
 * 分解出的单帧文件名：序号按总帧数补零。
 *
 * @param base 原文件名主体（不含扩展名）
 * @param index 帧序号（从 0 起）
 * @param total 总帧数
 * @returns 如 `anim_007.png`
 * @example frameFileName('anim', 6, 120) // 'anim_007.png'
 */
export function frameFileName(base: string, index: number, total: number): string {
  const width = String(Math.max(1, total)).length
  return `${base}_${String(index + 1).padStart(width, '0')}.png`
}

/**
 * 判断是不是 GIF（看 MIME，其次看扩展名）。
 *
 * @param mime MIME
 * @param name 文件名
 * @returns 是 GIF 为 true
 * @example isGif('', 'a.GIF') // true
 */
export function isGif(mime: string, name: string): boolean {
  return mime === 'image/gif' || /\.gif$/i.test(name)
}
