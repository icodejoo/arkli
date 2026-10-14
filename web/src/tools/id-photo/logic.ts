/**
 * 证件照的纯逻辑：规格、裁剪框与图的坐标换算、纯色背景抠图（颜色距离 + 边缘羽化）。
 * 不依赖 DOM。尺寸单位都是像素，规格按 300dpi 换算。
 */

/** 证件照规格 */
export interface IdSpec {
  /** 规格标识 */
  id: string
  /** 中文名 */
  name: string
  /** 输出宽（像素） */
  width: number
  /** 输出高（像素） */
  height: number
}

/** 自定义尺寸每边的下限 */
export const CUSTOM_MIN = 100
/** 自定义尺寸每边的上限 */
export const CUSTOM_MAX = 4000
/** 自定义规格的标识 */
export const CUSTOM_ID = 'custom'
/** 裁剪框占满时的比例 */
export const FRAC_MAX = 1
/** 裁剪框最小比例 */
export const FRAC_MIN = 0.2
/** RGB 欧氏距离的最大值（黑到白） */
export const MAX_COLOR_DISTANCE = 442
/** 取色时取点周围的半径（像素） */
const SAMPLE_RADIUS = 2

/** 内置规格（300dpi：一寸 25×35mm ≈ 295×413，二寸 35×49mm ≈ 413×579，小二寸 33×48mm ≈ 390×567，美签 2×2in = 600×600） */
export const ID_SPECS: IdSpec[] = [
  { id: 'one-inch', name: '一寸 295×413', width: 295, height: 413 },
  { id: 'two-inch', name: '二寸 413×579', width: 413, height: 579 },
  { id: 'small-two-inch', name: '小二寸 390×567', width: 390, height: 567 },
  { id: 'us-visa', name: '美国签证 600×600', width: 600, height: 600 },
]

/** 常用底色 */
export const BG_PRESETS = [
  { id: 'white', name: '白', color: '#ffffff' },
  { id: 'blue', name: '蓝', color: '#438edb' },
  { id: 'red', name: '红', color: '#d9342b' },
]

/** RGB 颜色 */
export type Rgb = [number, number, number]

/** 裁剪框状态 */
export interface CropState {
  /** 框的大小比例，FRAC_MIN~1，1 表示在图内能放下的最大框 */
  frac: number
  /** 框中心 x（图像素坐标） */
  cx: number
  /** 框中心 y（图像素坐标） */
  cy: number
}

/** 图像素坐标下的矩形 */
export interface CropRect {
  /** 左 */
  x: number
  /** 上 */
  y: number
  /** 宽 */
  w: number
  /** 高 */
  h: number
}

/**
 * 把数值夹到范围内。
 *
 * @param v 值
 * @param min 下限
 * @param max 上限
 * @returns 夹紧后的值
 * @example clamp(5, 0, 3) // 3
 */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * 构造自定义规格，每边夹到 [CUSTOM_MIN, CUSTOM_MAX] 并取整。
 *
 * @param width 宽
 * @param height 高
 * @returns 规格
 * @example customSpec(10, 99999) // { id: 'custom', name: '自定义 100×4000', width: 100, height: 4000 }
 */
export function customSpec(width: number, height: number): IdSpec {
  const w = clamp(Math.round(width) || CUSTOM_MIN, CUSTOM_MIN, CUSTOM_MAX)
  const h = clamp(Math.round(height) || CUSTOM_MIN, CUSTOM_MIN, CUSTOM_MAX)
  return { id: CUSTOM_ID, name: `自定义 ${w}×${h}`, width: w, height: h }
}

/**
 * 规格宽高比。
 *
 * @param spec 规格
 * @returns 宽 / 高
 * @example specAspect(ID_SPECS[0]) // 0.714
 */
export function specAspect(spec: IdSpec): number {
  return spec.width / spec.height
}

/**
 * 在图内能放下的最大框（比例固定）的宽。
 *
 * @param iw 图宽
 * @param ih 图高
 * @param aspect 框宽高比
 * @returns 最大框宽
 * @example maxCropWidth(1000, 1000, 0.5) // 500
 */
export function maxCropWidth(iw: number, ih: number, aspect: number): number {
  return Math.min(iw, ih * aspect)
}

/**
 * 初始裁剪状态：最大框、居中。
 *
 * @param iw 图宽
 * @param ih 图高
 * @param aspect 框宽高比
 * @returns 初始状态
 * @example initialCrop(1000, 1000, 0.5) // { frac: 1, cx: 500, cy: 500 }
 */
export function initialCrop(iw: number, ih: number, aspect: number): CropState {
  return clampCrop(iw, ih, aspect, { frac: FRAC_MAX, cx: iw / 2, cy: ih / 2 })
}

/**
 * 夹紧裁剪状态：比例在范围内，框完全落在图里。
 *
 * @param iw 图宽
 * @param ih 图高
 * @param aspect 框宽高比
 * @param s 状态
 * @returns 合法状态（新对象）
 * @example clampCrop(100, 100, 1, { frac: 1, cx: -50, cy: 500 }) // { frac: 1, cx: 50, cy: 50 }
 */
export function clampCrop(iw: number, ih: number, aspect: number, s: CropState): CropState {
  const frac = clamp(s.frac, FRAC_MIN, FRAC_MAX)
  const w = maxCropWidth(iw, ih, aspect) * frac
  const h = w / aspect
  return { frac, cx: clamp(s.cx, w / 2, iw - w / 2), cy: clamp(s.cy, h / 2, ih - h / 2) }
}

/**
 * 状态换算成图像素坐标下的裁剪矩形（取整）。
 *
 * @param iw 图宽
 * @param ih 图高
 * @param aspect 框宽高比
 * @param s 状态
 * @returns 矩形
 * @example cropRect(1000, 1000, 0.5, { frac: 1, cx: 500, cy: 500 }) // { x: 250, y: 0, w: 500, h: 1000 }
 */
export function cropRect(iw: number, ih: number, aspect: number, s: CropState): CropRect {
  const c = clampCrop(iw, ih, aspect, s)
  const w = maxCropWidth(iw, ih, aspect) * c.frac
  const h = w / aspect
  return { x: Math.round(c.cx - w / 2), y: Math.round(c.cy - h / 2), w: Math.round(w), h: Math.round(h) }
}

/**
 * 平移裁剪框。
 *
 * @param iw 图宽
 * @param ih 图高
 * @param aspect 框宽高比
 * @param s 当前状态
 * @param dx 横向位移（图像素）
 * @param dy 纵向位移（图像素）
 * @returns 新状态，框不会移出图
 * @example moveCrop(1000, 1000, 1, { frac: 0.5, cx: 500, cy: 500 }, 100, 0).cx // 600
 */
export function moveCrop(iw: number, ih: number, aspect: number, s: CropState, dx: number, dy: number): CropState {
  return clampCrop(iw, ih, aspect, { ...s, cx: s.cx + dx, cy: s.cy + dy })
}

/**
 * 双指缩放：两指拉开框变大，捏合框变小。
 *
 * @param frac 当前比例
 * @param d0 手势开始时两指距离
 * @param d1 现在两指距离
 * @returns 新比例（夹在范围内）；d0 非正时原样返回
 * @example pinchFrac(0.5, 100, 200) // 1
 */
export function pinchFrac(frac: number, d0: number, d1: number): number {
  if (d0 <= 0) return frac
  return clamp(frac * (d1 / d0), FRAC_MIN, FRAC_MAX)
}

/**
 * 裁剪矩形换算成预览容器里的百分比定位，用于叠加框。
 *
 * @param rect 图像素坐标下的矩形
 * @param iw 图宽
 * @param ih 图高
 * @returns 左、上、宽、高的百分比（0~100）
 * @example rectToPercent({ x: 250, y: 0, w: 500, h: 1000 }, 1000, 1000) // { left: 25, top: 0, width: 50, height: 100 }
 */
export function rectToPercent(rect: CropRect, iw: number, ih: number): { left: number; top: number; width: number; height: number } {
  return { left: (rect.x / iw) * 100, top: (rect.y / ih) * 100, width: (rect.w / iw) * 100, height: (rect.h / ih) * 100 }
}

/**
 * 解析 `#rgb` / `#rrggbb`。
 *
 * @param hex 颜色字符串
 * @returns RGB；格式不对返回 null
 * @example hexToRgb('#438edb') // [67, 142, 219]
 */
export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let s = m[1]
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}

/**
 * RGB 转 `#rrggbb`。
 *
 * @param rgb 颜色
 * @returns 小写十六进制
 * @example rgbToHex([67, 142, 219]) // '#438edb'
 */
export function rgbToHex(rgb: Rgb): string {
  return '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')
}

/**
 * 两个颜色的 RGB 欧氏距离。
 *
 * @param a 颜色 A
 * @param b 颜色 B
 * @returns 距离，0~442
 * @example colorDistance([0, 0, 0], [255, 255, 255]) // 441.67
 */
export function colorDistance(a: Rgb, b: Rgb): number {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/**
 * 在 RGBA 图上取点周围小窗口的平均色，抗噪点。
 *
 * @param data RGBA 字节
 * @param w 宽
 * @param h 高
 * @param x 取点 x
 * @param y 取点 y
 * @returns 平均 RGB
 * @example sampleColor(data, 10, 10, 5, 5)
 */
export function sampleColor(data: ArrayLike<number>, w: number, h: number, x: number, y: number): Rgb {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let yy = Math.round(y) - SAMPLE_RADIUS; yy <= Math.round(y) + SAMPLE_RADIUS; yy++) {
    for (let xx = Math.round(x) - SAMPLE_RADIUS; xx <= Math.round(x) + SAMPLE_RADIUS; xx++) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
      const p = (yy * w + xx) * 4
      r += data[p]
      g += data[p + 1]
      b += data[p + 2]
      n++
    }
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0]
}

/**
 * 求背景掩码：与取色相近（距离 ≤ 容差）的像素；
 * onlyConnected 为 true 时只保留与图像边缘相连的那部分，人物身上和背景同色的区域不会被误抠。
 *
 * @param data RGBA 字节
 * @param w 宽
 * @param h 高
 * @param key 背景取色
 * @param tolerance 容差（RGB 距离）
 * @param onlyConnected 是否只抠与边缘相连的背景
 * @returns 掩码，1 为背景
 * @example backgroundMask(data, w, h, [255, 255, 255], 40, true)
 */
export function backgroundMask(data: ArrayLike<number>, w: number, h: number, key: Rgb, tolerance: number, onlyConnected: boolean): Uint8Array {
  const near = new Uint8Array(w * h)
  for (let i = 0; i < near.length; i++) {
    near[i] = colorDistance([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]], key) <= tolerance ? 1 : 0
  }
  if (!onlyConnected) return near
  const out = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  let sp = 0
  const push = (p: number): void => {
    if (near[p] && !out[p]) {
      out[p] = 1
      stack[sp++] = p
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  while (sp > 0) {
    const p = stack[--sp]
    const x = p % w
    const y = (p - x) / w
    if (x > 0) push(p - 1)
    if (x < w - 1) push(p + 1)
    if (y > 0) push(p - w)
    if (y < h - 1) push(p + w)
  }
  return out
}

/**
 * 边缘羽化 1px：背景像素 alpha 恒为 0；紧贴背景的前景像素取 3×3 邻域的前景占比作为 alpha，
 * 让主体边缘一圈与新底色柔和过渡（不会把旧背景的颜色带进来形成白边）。
 *
 * @param mask 背景掩码（1 为背景）
 * @param w 宽
 * @param h 高
 * @returns 每像素 alpha（0~255，0 为完全透明的背景）
 * @example featherAlpha(mask, w, h)
 */
export function featherAlpha(mask: ArrayLike<number>, w: number, h: number): Uint8Array {
  const alpha = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) continue
      let fg = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          n++
          if (!mask[yy * w + xx]) fg++
        }
      }
      alpha[y * w + x] = fg === n ? 255 : Math.round((fg / n) * 255)
    }
  }
  return alpha
}

/**
 * 纯色背景抠图并铺新底色：就地修改 RGBA，输出每个像素 alpha 都为 255（已合成到新底色上）。
 *
 * @param data RGBA 字节（会被修改）
 * @param w 宽
 * @param h 高
 * @param key 原背景色
 * @param tolerance 容差（RGB 距离）
 * @param bg 新底色
 * @param onlyConnected 是否只抠与边缘相连的背景，默认 true
 * @returns 抠掉的背景像素数（便于提示「没抠到东西，调大容差」）
 * @example const removed = replaceBackground(imageData.data, w, h, [255, 255, 255], 40, [67, 142, 219])
 */
export function replaceBackground(data: Uint8ClampedArray, w: number, h: number, key: Rgb, tolerance: number, bg: Rgb, onlyConnected = true): number {
  const mask = backgroundMask(data, w, h, key, tolerance, onlyConnected)
  const alpha = featherAlpha(mask, w, h)
  let removed = 0
  for (let i = 0; i < alpha.length; i++) {
    if (mask[i]) removed++
    const a = alpha[i] / 255
    const p = i * 4
    data[p] = Math.round(data[p] * a + bg[0] * (1 - a))
    data[p + 1] = Math.round(data[p + 1] * a + bg[1] * (1 - a))
    data[p + 2] = Math.round(data[p + 2] * a + bg[2] * (1 - a))
    data[p + 3] = 255
  }
  return removed
}
