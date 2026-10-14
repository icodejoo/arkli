/**
 * OCR 四点框的几何小工具，文字识别与图片提取表格共用。
 * 框格式：[x1,y1,x2,y2,x3,y3,x4,y4]，单位为原图像素。
 */

/** 框的外接矩形与中心 */
export interface BoxRect {
  /** 左 */
  x1: number
  /** 上 */
  y1: number
  /** 右 */
  x2: number
  /** 下 */
  y2: number
  /** 中心 x */
  cx: number
  /** 中心 y */
  cy: number
  /** 宽 */
  w: number
  /** 高 */
  h: number
}

/**
 * 求四点框的外接矩形。
 *
 * @param box 四点框，至少 2 个点（4 个数）
 * @returns 外接矩形；点数不足时返回全 0
 * @example boxRect([0,0,10,0,10,4,0,4]) // { x1:0, y1:0, x2:10, y2:4, cx:5, cy:2, w:10, h:4 }
 */
export function boxRect(box: number[]): BoxRect {
  if (box.length < 4) return { x1: 0, y1: 0, x2: 0, y2: 0, cx: 0, cy: 0, w: 0, h: 0 }
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (let i = 0; i + 1 < box.length; i += 2) {
    x1 = Math.min(x1, box[i])
    x2 = Math.max(x2, box[i])
    y1 = Math.min(y1, box[i + 1])
    y2 = Math.max(y2, box[i + 1])
  }
  return { x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, w: x2 - x1, h: y2 - y1 }
}

/**
 * 判断点是否落在四点框（多边形）内，射线法。
 *
 * @param box 四点框
 * @param x 点 x
 * @param y 点 y
 * @returns 在框内为 true
 * @example pointInBox([0,0,10,0,10,4,0,4], 5, 2) // true
 */
export function pointInBox(box: number[], x: number, y: number): boolean {
  const n = Math.floor(box.length / 2)
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = box[i * 2]
    const yi = box[i * 2 + 1]
    const xj = box[j * 2]
    const yj = box[j * 2 + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * 把框按比例缩放，用于把原图坐标换算到预览坐标。
 *
 * @param box 四点框
 * @param k 缩放系数
 * @returns 新框
 * @example scaleBox([0,0,10,0,10,4,0,4], 0.5) // [0,0,5,0,5,2,0,2]
 */
export function scaleBox(box: number[], k: number): number[] {
  return box.map((v) => v * k)
}

/**
 * 四点框转 SVG polygon 的 points 字符串。
 *
 * @param box 四点框
 * @returns 形如 `0,0 10,0 10,4 0,4`
 * @example boxPoints([0,0,10,0,10,4,0,4]) // '0,0 10,0 10,4 0,4'
 */
export function boxPoints(box: number[]): string {
  const out: string[] = []
  for (let i = 0; i + 1 < box.length; i += 2) out.push(`${box[i]},${box[i + 1]}`)
  return out.join(' ')
}
