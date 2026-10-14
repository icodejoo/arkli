/**
 * 幻影坦克的像素算法（灰度版）。
 *
 * 原理：输出一张带 alpha 的灰度 PNG，像素 (g, α) 放在不同底色上显示为：
 *   白底：g·α + 255·(1-α)
 *   黑底：g·α
 * 我们要白底看到表图 A'、黑底看到里图 B'，联立得：
 *   g·α = B'
 *   B' + 255·(1-α) = A'   =>   α = 1 - (A' - B') / 255,   g = B' / α
 *
 * 要让 α 落在 [0,1]，必须保证 A' ≥ B'（每个像素表图都不比里图暗）。做法是把两张图压到不重叠的亮度区间：
 *   A' = LIGHT_FLOOR + A·(255 - LIGHT_FLOOR)/255   表图提到亮部 [128, 255]
 *   B' = B·DARK_CEIL/255                            里图压到暗部 [0, 128]
 * 取舍：两张图各只剩一半亮度范围，对比度减半，是这个经典做法的固有代价；
 * 里图可在压暗前先拉对比度（contrast），让暗部细节更容易在黑底浮现。
 * 彩色版算法更复杂、效果有限，这里只做灰度。
 *
 * 不碰 DOM，可直接单测。
 */

/** 表图亮度下限（表图被映射到 [LIGHT_FLOOR, 255]） */
export const LIGHT_FLOOR = 128
/** 里图亮度上限（里图被映射到 [0, DARK_CEIL]） */
export const DARK_CEIL = 128
/** 里图对比度下限 */
export const CONTRAST_MIN = 0.5
/** 里图对比度上限 */
export const CONTRAST_MAX = 2.5
/** 里图对比度默认值 */
export const CONTRAST_DEFAULT = 1
/** 合成图最长边上限，控制内存与耗时（聊天软件也会压缩，没必要太大） */
export const MAX_EDGE = 2400
/** 每像素通道数（RGBA） */
const CHANNELS = 4
/** 亮度中点，对比度绕它拉伸 */
const MID = 128

/** 合成参数 */
export interface PhantomOptions {
  /** 里图对比度，CONTRAST_MIN~CONTRAST_MAX，1 为不变 */
  contrast: number
}

/**
 * 由 RGB 算灰度亮度（Rec.601）。
 *
 * @param r 红
 * @param g 绿
 * @param b 蓝
 * @returns 0~255 的亮度
 * @example luma(255, 255, 255) // 255
 */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * 限制对比度到允许范围，非数字回默认值。
 *
 * @param v 输入对比度
 * @example clampContrast(9) // 2.5
 */
export function clampContrast(v: number): number {
  return Number.isFinite(v) ? Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, v)) : CONTRAST_DEFAULT
}

/**
 * 单像素合成：表图亮度、里图亮度 → 输出灰度与 alpha（均为 0~255 整数）。
 *
 * @param a 表图亮度 0~255
 * @param b 里图亮度 0~255
 * @param contrast 里图对比度
 * @returns gray 与 alpha；alpha 为 0 时 gray 为 0（该点白底纯白、黑底纯黑，仅出现在表图最亮且里图最暗处）
 * @example phantomPixel(255, 0, 1) // { gray: 0, alpha: 0 }
 */
export function phantomPixel(a: number, b: number, contrast: number): { gray: number; alpha: number } {
  const bc = Math.min(255, Math.max(0, (b - MID) * contrast + MID))
  const top = LIGHT_FLOOR + (Math.min(255, Math.max(0, a)) * (255 - LIGHT_FLOOR)) / 255
  const bottom = (bc * DARK_CEIL) / 255
  const alpha = Math.round((1 - (top - bottom) / 255) * 255)
  if (alpha <= 0) return { gray: 0, alpha: 0 }
  return { gray: Math.min(255, Math.round((bottom * 255) / alpha)), alpha }
}

/**
 * 合成整张图。两张图必须同尺寸（页面里先各自按 cover 画到同一画布）。
 *
 * @param surface 表图 RGBA（白底下看到的），应已铺白底去透明
 * @param inner 里图 RGBA（黑底下看到的），长度须与表图一致
 * @param opts 合成参数
 * @returns 新的 RGBA 数据：灰度 + alpha
 * @throws 两张图长度不一致时抛错
 * @example const out = composePhantom(a.data, b.data, { contrast: 1.2 })
 */
export function composePhantom(surface: ArrayLike<number>, inner: ArrayLike<number>, opts: PhantomOptions): Uint8ClampedArray {
  if (surface.length !== inner.length) throw new Error('表图与里图尺寸不一致')
  const contrast = clampContrast(opts.contrast)
  const out = new Uint8ClampedArray(surface.length)
  for (let i = 0; i + 3 < surface.length; i += CHANNELS) {
    const a = luma(surface[i], surface[i + 1], surface[i + 2])
    const b = luma(inner[i], inner[i + 1], inner[i + 2])
    const p = phantomPixel(a, b, contrast)
    out[i] = p.gray
    out[i + 1] = p.gray
    out[i + 2] = p.gray
    out[i + 3] = p.alpha
  }
  return out
}

/**
 * 把输出像素放到纯色背景上，得到屏幕上看到的灰度值（用于校验与对比）。
 *
 * @param gray 输出灰度 0~255
 * @param alpha 输出 alpha 0~255
 * @param bg 背景亮度，白 255、黑 0
 * @returns 显示出来的灰度
 * @example displayOn(0, 0, 255) // 255
 */
export function displayOn(gray: number, alpha: number, bg: number): number {
  const k = alpha / 255
  return gray * k + bg * (1 - k)
}

/**
 * 计算“cover”裁剪：把源图铺满目标尺寸时，应取源图的哪块区域。
 *
 * @param srcW 源宽
 * @param srcH 源高
 * @param dstW 目标宽
 * @param dstH 目标高
 * @returns 源图上的裁剪矩形（居中）
 * @example coverRect(200, 100, 100, 100) // { x: 50, y: 0, w: 100, h: 100 }
 */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number): { x: number; y: number; w: number; h: number } {
  const k = Math.max(dstW / srcW, dstH / srcH)
  const w = dstW / k
  const h = dstH / k
  return { x: (srcW - w) / 2, y: (srcH - h) / 2, w, h }
}
