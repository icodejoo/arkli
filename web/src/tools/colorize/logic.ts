/** 判断「已经有颜色」时，通道最大差的平均值阈值（0~255） */
export const COLORFUL_THRESHOLD = 12
/** 图片最长边上限 */
export const MAX_SIDE = 8000

/** 待校验的图片信息 */
export interface ColorizeInput {
  /** 预览地址，有值才算已选 */
  url?: string
  /** 宽 */
  width: number
  /** 高 */
  height: number
}

/**
 * 校验上色输入。
 *
 * @param img 图片
 * @returns 问题的中文提示；通过返回 null
 * @example validateColorize(null) // '请先选择一张黑白照片'
 */
export function validateColorize(img: ColorizeInput | null): string | null {
  if (!img || !img.url) return '请先选择一张黑白照片'
  if (Math.max(img.width, img.height) > MAX_SIDE) return '图片尺寸过大，请先缩小'
  return null
}

/**
 * 判断一张（缩略）图是不是已经有明显颜色：每个像素 RGB 三通道最大差的平均值超过阈值即为彩色。
 * 用来提示「这张图本来就有颜色」，不影响上色。
 *
 * @param data RGBA 字节
 * @param threshold 阈值，默认 COLORFUL_THRESHOLD
 * @returns 彩色为 true；没有像素返回 false
 * @example isColorful(new Uint8ClampedArray([255, 0, 0, 255])) // true
 */
export function isColorful(data: ArrayLike<number>, threshold = COLORFUL_THRESHOLD): boolean {
  const n = Math.floor(data.length / 4)
  if (!n) return false
  let sum = 0
  for (let i = 0; i < n; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    sum += Math.max(r, g, b) - Math.min(r, g, b)
  }
  return sum / n > threshold
}
