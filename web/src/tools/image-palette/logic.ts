/**
 * 取色器的纯逻辑：median-cut 主色提取、取点、HEX/RGB 格式化。
 * 不碰 DOM，可直接单测。
 */

/** 取色前图片最长边上限（像素） */
export const SAMPLE_MAX_EDGE = 256
/** 主色数量下限 */
export const PALETTE_MIN = 3
/** 主色数量上限 */
export const PALETTE_MAX = 12
/** 默认主色数量 */
export const PALETTE_DEFAULT = 6
/** 放大倍数下限 */
export const ZOOM_MIN = 2
/** 放大倍数上限 */
export const ZOOM_MAX = 10
/** 放大倍数默认值 */
export const ZOOM_DEFAULT = 5
/** 长按多久（毫秒）才唤起放大镜；更短的按下视为普通触摸，页面照常滚动 */
export const LONG_PRESS_MS = 350
/** 长按判定前允许的手指漂移（像素），超过就认为是在滑动页面 */
export const MOVE_SLOP = 10
/** 放大倍数的存储键 */
export const ZOOM_KEY = 'arkli:image-palette:zoom'
/** 放大镜气泡直径（CSS 像素） */
export const LOUPE_SIZE = 110
/** 放大镜与手指的间距（CSS 像素） */
export const LOUPE_GAP = 24
/** 半透明像素不参与统计的 alpha 阈值 */
const ALPHA_MIN = 128
/** 每像素通道数（RGBA） */
const CHANNELS = 4
/** 白色通道值，透明点按白底合成 */
const WHITE = 255
/** 判断文字用黑还是白的亮度阈值 */
const LUMA_LIGHT = 150

/** 一种颜色 */
export interface Rgb {
  /** 红 0~255 */
  r: number
  /** 绿 0~255 */
  g: number
  /** 蓝 0~255 */
  b: number
}

/** 主色项：颜色 + 占比 */
export interface PaletteColor extends Rgb {
  /** 该色块包含的像素数 */
  count: number
  /** 占全部不透明像素的比例 0~1 */
  ratio: number
}

/** 色块：一组像素序号 */
interface Box {
  /** 像素在紧凑 RGB 数组里的序号（每项占 3 个通道） */
  idx: number[]
}

/**
 * 把 RGB 转成 `#RRGGBB`（大写）。
 *
 * @param c 颜色
 * @returns 十六进制色值
 * @example toHex({ r: 255, g: 0, b: 128 }) // '#FF0080'
 */
export function toHex(c: Rgb): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase()
}

/**
 * 把 RGB 转成 `rgb(r, g, b)` 文案。
 *
 * @param c 颜色
 * @returns rgb 文案
 * @example toRgbText({ r: 1, g: 2, b: 3 }) // 'rgb(1, 2, 3)'
 */
export function toRgbText(c: Rgb): string {
  return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
}

/**
 * 按亮度挑选可读的文字色（黑或白），用于色块上叠字。
 *
 * @param c 背景色
 * @returns `#000000` 或 `#FFFFFF`
 * @example readableTextColor({ r: 255, g: 255, b: 255 }) // '#000000'
 */
export function readableTextColor(c: Rgb): string {
  const luma = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
  return luma > LUMA_LIGHT ? '#000000' : '#FFFFFF'
}

/**
 * 取图片数据中某个像素的颜色。
 *
 * @param data RGBA 数据（如 ImageData.data）
 * @param width 图宽
 * @param height 图高
 * @param x 横坐标（整数）
 * @param y 纵坐标（整数）
 * @returns 颜色；越界返回 null。半透明点按白底合成
 * @example getPixel(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1, 0, 0) // { r: 1, g: 2, b: 3 }
 */
export function getPixel(data: ArrayLike<number>, width: number, height: number, x: number, y: number): Rgb | null {
  if (x < 0 || y < 0 || x >= width || y >= height) return null
  const i = (y * width + x) * CHANNELS
  const a = data[i + 3] / 255
  const mix = (v: number) => v * a + WHITE * (1 - a)
  return { r: mix(data[i]), g: mix(data[i + 1]), b: mix(data[i + 2]) }
}

/**
 * 把点击位置换算成取样图上的像素坐标。
 *
 * @param offsetX 点击点相对显示区域左上角的 x
 * @param offsetY 点击点相对显示区域左上角的 y
 * @param viewW 显示区域宽
 * @param viewH 显示区域高
 * @param imgW 取样图宽
 * @param imgH 取样图高
 * @returns 像素坐标（已限制在图内）；尺寸非法返回 null
 * @example pointToPixel(50, 25, 100, 50, 10, 5) // { x: 5, y: 2 }
 */
export function pointToPixel(
  offsetX: number,
  offsetY: number,
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
): { x: number; y: number } | null {
  if (viewW <= 0 || viewH <= 0 || imgW <= 0 || imgH <= 0) return null
  const x = Math.min(imgW - 1, Math.max(0, Math.floor((offsetX / viewW) * imgW)))
  const y = Math.min(imgH - 1, Math.max(0, Math.floor((offsetY / viewH) * imgH)))
  return { x, y }
}

/** 色块在某通道上的取值跨度 */
function channelRange(rgb: ArrayLike<number>, box: Box, ch: number): number {
  let lo = 255
  let hi = 0
  for (const i of box.idx) {
    const v = rgb[i * 3 + ch]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return hi - lo
}

/**
 * 在已按通道排序的序号里找切分位置：取最靠近中位数、且前后取值不同的边界，
 * 避免把同一种颜色劈成两半。调用方保证该通道有跨度。
 */
function splitPoint(rgb: ArrayLike<number>, idx: number[], ch: number): number {
  const mid = idx.length >> 1
  const at = (k: number) => rgb[idx[k] * 3 + ch]
  for (let d = 0; d < idx.length; d++) {
    for (const j of [mid - d, mid + d]) {
      if (j > 0 && j < idx.length && at(j - 1) !== at(j)) return j
    }
  }
  return mid
}

/**
 * median-cut 提取主色。
 * 流程：收集不透明像素 → 反复把“像素最多且还有颜色跨度”的色块沿跨度最大的通道在中位数处切开 → 各块取均值。
 *
 * @param data RGBA 数据（建议先缩到 SAMPLE_MAX_EDGE 以内）
 * @param count 目标颜色数，限制在 PALETTE_MIN~PALETTE_MAX；图里颜色不够时返回更少
 * @returns 按占比从高到低排序的主色；全透明图返回空数组
 * @example medianCut(imageData.data, 6).map(toHex)
 */
export function medianCut(data: ArrayLike<number>, count: number): PaletteColor[] {
  const target = Math.max(PALETTE_MIN, Math.min(PALETTE_MAX, Math.round(count)))
  // 压成紧凑的 RGB 数组，跳过半透明像素
  const rgb: number[] = []
  for (let i = 0; i + 3 < data.length; i += CHANNELS) {
    if (data[i + 3] < ALPHA_MIN) continue
    rgb.push(data[i], data[i + 1], data[i + 2])
  }
  const total = rgb.length / 3
  if (total === 0) return []
  const all: number[] = []
  for (let i = 0; i < total; i++) all.push(i)
  const boxes: Box[] = [{ idx: all }]

  while (boxes.length < target) {
    // 选像素最多、且颜色上确有跨度可切的色块
    let pick = -1
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b]
      if (box.idx.length < 2) continue
      const span = Math.max(channelRange(rgb, box, 0), channelRange(rgb, box, 1), channelRange(rgb, box, 2))
      if (span === 0) continue
      if (pick < 0 || box.idx.length > boxes[pick].idx.length) pick = b
    }
    if (pick < 0) break
    const box = boxes[pick]
    const ranges = [0, 1, 2].map((ch) => channelRange(rgb, box, ch))
    const ch = ranges.indexOf(Math.max(...ranges))
    box.idx.sort((a, b) => rgb[a * 3 + ch] - rgb[b * 3 + ch])
    const mid = splitPoint(rgb, box.idx, ch)
    boxes.splice(pick, 1, { idx: box.idx.slice(0, mid) }, { idx: box.idx.slice(mid) })
  }

  return boxes
    .map((box) => {
      let r = 0
      let g = 0
      let b = 0
      for (const i of box.idx) {
        r += rgb[i * 3]
        g += rgb[i * 3 + 1]
        b += rgb[i * 3 + 2]
      }
      const n = box.idx.length
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), count: n, ratio: n / total }
    })
    .sort((a, b) => b.count - a.count)
}

/**
 * 放大倍数换算成取样窗口边长：气泡直径除以倍数，取整并保证是奇数（正中间要有一个像素），至少 3。
 *
 * @param zoom 放大倍数，会被夹到 {@link ZOOM_MIN}~{@link ZOOM_MAX}，非数字按默认值
 * @returns 取样窗口边长（原图像素）
 * @example
 * loupeWindow(10) // 11
 * loupeWindow(2) // 55
 */
export function loupeWindow(zoom: number): number {
  const z = Number.isFinite(zoom) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) : ZOOM_DEFAULT
  const n = Math.max(3, Math.round(LOUPE_SIZE / z))
  return n % 2 === 0 ? n + 1 : n
}

/**
 * 读存下来的放大倍数。
 *
 * @param raw localStorage 里取到的原始值，没有为 null
 * @returns 夹在范围内的整数倍数；没有或非法返回默认值
 * @example
 * loadZoom('12') // 12
 */
export function loadZoom(raw: string | null): number {
  const n = Number(raw)
  if (raw === null || !Number.isFinite(n)) return ZOOM_DEFAULT
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n)))
}

/**
 * 放大镜在原图上的取样矩形：以指向的像素为中心的正方形窗口。
 * 窗口可能超出图片边界，canvas 的 drawImage 会自动裁掉超出部分。
 *
 * @param cx 指向像素的 x（原图坐标）
 * @param cy 指向像素的 y（原图坐标）
 * @param win 窗口边长（原图像素，奇数），一般来自 {@link loupeWindow}
 * @returns 窗口左上角与边长
 * @example
 * loupeSourceRect(100, 50, 11) // { sx: 95, sy: 45, size: 11 }
 */
export function loupeSourceRect(cx: number, cy: number, win: number): { sx: number; sy: number; size: number } {
  const half = Math.floor(win / 2)
  return { sx: cx - half, sy: cy - half, size: win }
}

/**
 * 手指从按下点漂移是否已超过长按允许的范围。
 *
 * @param dx 横向位移（像素）
 * @param dy 纵向位移（像素）
 * @param slop 允许的漂移，默认 {@link MOVE_SLOP}
 * @returns 超过为 true（说明用户在滑动，不是长按）
 * @example
 * movedBeyondSlop(3, 4) // false
 */
export function movedBeyondSlop(dx: number, dy: number, slop = MOVE_SLOP): boolean {
  return Math.hypot(dx, dy) > slop
}
