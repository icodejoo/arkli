import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE } from '@/shared/image-calc'

/** 可选放大倍数 */
export type UpscaleScale = 2 | 4

/** 可选倍数列表 */
export const UPSCALE_SCALES: UpscaleScale[] = [2, 4]
/** 输出像素上限（与 Canvas 安全上限一致，超了保存/预览会失败） */
export const MAX_OUTPUT_PIXELS = MAX_CANVAS_PIXELS
/** 每像素 RGBA 字节数 */
const BYTES_PER_PIXEL = 4
/** 1 MB 字节数 */
const MB = 1024 * 1024
/** 对比滑块默认位置（中间） */
export const DEFAULT_SPLIT = 0.5

/** 放大预估 */
export interface UpscaleEstimate {
  /** 输出宽 */
  width: number
  /** 输出高 */
  height: number
  /** 输出像素数 */
  pixels: number
  /** 解码后的大致内存（字节，RGBA） */
  memoryBytes: number
  /** 是否超出输出上限 */
  tooBig: boolean
}

/**
 * 预估放大后的尺寸与内存。
 *
 * @param width 原图宽
 * @param height 原图高
 * @param scale 放大倍数
 * @returns 输出尺寸、像素、内存与是否超限
 * @example estimateUpscale(1000, 800, 4) // { width: 4000, height: 3200, pixels: 12800000, memoryBytes: 51200000, tooBig: false }
 */
export function estimateUpscale(width: number, height: number, scale: UpscaleScale): UpscaleEstimate {
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  const pixels = w * h
  return {
    width: w,
    height: h,
    pixels,
    memoryBytes: pixels * BYTES_PER_PIXEL,
    tooBig: w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE || pixels > MAX_OUTPUT_PIXELS,
  }
}

/**
 * 当前图最大能放大几倍（不超过输出上限）。
 *
 * @param width 原图宽
 * @param height 原图高
 * @returns 4、2；连 2 倍都超限时为 0
 * @example maxAllowedScale(1000, 1000) // 4
 */
export function maxAllowedScale(width: number, height: number): 0 | UpscaleScale {
  for (let i = UPSCALE_SCALES.length - 1; i >= 0; i--) {
    if (!estimateUpscale(width, height, UPSCALE_SCALES[i]).tooBig) return UPSCALE_SCALES[i]
  }
  return 0
}

/**
 * 预估文案。
 *
 * @param est 预估结果
 * @returns 如 `输出 4000×3200，约占 48.8 MB 内存`；超限时提示换小图或倍数
 * @example estimateText(estimateUpscale(1000, 800, 4))
 */
export function estimateText(est: UpscaleEstimate): string {
  if (est.tooBig) return `输出 ${est.width}×${est.height} 超出上限（${Math.round(MAX_OUTPUT_PIXELS / 1e6)} 百万像素），请换小一点的图或降低倍数`
  return `输出 ${est.width}×${est.height}，解码约占 ${(est.memoryBytes / MB).toFixed(1)} MB 内存`
}

/**
 * 把指针位置换算成滑块比例，夹在 0~1。
 *
 * @param clientX 指针横坐标
 * @param left 容器左边
 * @param width 容器宽
 * @returns 0~1；容器宽为 0 时返回默认位置
 * @example splitFromPointer(150, 100, 200) // 0.25
 */
export function splitFromPointer(clientX: number, left: number, width: number): number {
  if (width <= 0) return DEFAULT_SPLIT
  return Math.min(1, Math.max(0, (clientX - left) / width))
}

/**
 * 「处理前」图层的裁剪样式：只露出分隔线左边那部分。
 *
 * @param split 滑块比例 0~1
 * @returns CSS clip-path 值
 * @example splitClip(0.25) // 'inset(0 75% 0 0)'
 */
export function splitClip(split: number): string {
  const s = Math.min(1, Math.max(0, split))
  return `inset(0 ${+((1 - s) * 100).toFixed(2)}% 0 0)`
}

/**
 * 输出文件名后缀。
 *
 * @param scale 倍数
 * @returns 如 `_x2`
 * @example scaleSuffix(2) // '_x2'
 */
export function scaleSuffix(scale: UpscaleScale): string {
  return `_x${scale}`
}
