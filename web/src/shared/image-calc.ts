/**
 * 图片类工具共用的纯计算：尺寸、网格、拼接布局、体积与 MIME 映射。
 * 不碰 DOM，可直接单测。
 */

/** Canvas 单边上限（保守值，见 docs/design/tools/image.md，真机实测后调） */
export const MAX_CANVAS_SIDE = 16384

/** Canvas 总像素上限（保守值 6400 万），超过的图 v1 只提示缩小 */
export const MAX_CANVAS_PIXELS = 64_000_000

/** 输出格式键 */
export type OutputFormat = 'png' | 'jpeg' | 'webp'

/** 输出格式对应的 MIME */
export const FORMAT_MIME: Record<OutputFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/** MIME 到扩展名 */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
}

/** 字节换算基数 */
const KB = 1024

/** 尺寸 */
export interface Size {
  /** 宽（像素） */
  width: number
  /** 高（像素） */
  height: number
}

/** 矩形（源图或画布坐标） */
export interface Rect {
  /** 左上角 x */
  x: number
  /** 左上角 y */
  y: number
  /** 宽 */
  w: number
  /** 高 */
  h: number
}

/**
 * 判断尺寸是否超出 Canvas 安全范围。
 *
 * @param width 宽
 * @param height 高
 * @returns 超限为 true
 * @example exceedsCanvas(20000, 100) // true
 */
export function exceedsCanvas(width: number, height: number): boolean {
  return width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE || width * height > MAX_CANVAS_PIXELS
}

/**
 * 按最长边限制缩放，只缩小不放大。
 *
 * @param width 原宽
 * @param height 原高
 * @param maxEdge 最长边上限，0 或负数表示不限制
 * @returns 目标尺寸与缩放比例
 * @example fitMaxEdge(4000, 3000, 2000) // { width: 2000, height: 1500, scale: 0.5 }
 */
export function fitMaxEdge(width: number, height: number, maxEdge: number): Size & { scale: number } {
  const longest = Math.max(width, height)
  if (maxEdge <= 0 || longest <= maxEdge) return { width, height, scale: 1 }
  const scale = maxEdge / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
}

/**
 * 缩小超过一半时逐级减半的中间尺寸序列（最后一项是目标尺寸）。
 *
 * @param sw 源宽
 * @param sh 源高
 * @param tw 目标宽
 * @param th 目标高
 * @returns 依次绘制的尺寸；放大或差距不到 2 倍时只有目标一项
 * @example halvingSteps(4000, 3000, 1000, 750) // [{2000,1500}, {1000,750}]
 */
export function halvingSteps(sw: number, sh: number, tw: number, th: number): Size[] {
  const steps: Size[] = []
  let w = sw
  let h = sh
  while (w / 2 > tw && h / 2 > th) {
    w = Math.round(w / 2)
    h = Math.round(h / 2)
    steps.push({ width: w, height: h })
  }
  steps.push({ width: tw, height: th })
  return steps
}

/**
 * 格式化字节数。
 *
 * @param bytes 字节数
 * @returns 如 `532 B`、`1.5 KB`、`2.30 MB`
 * @example formatBytes(1536) // '1.5 KB'
 */
export function formatBytes(bytes: number): string {
  if (bytes < KB) return `${Math.max(0, Math.round(bytes))} B`
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(1)} KB`
  return `${(bytes / KB / KB).toFixed(2)} MB`
}

/**
 * 体积变化文案：变小为 `-62%`，变大为 `+5%`，不变为 `0%`。
 *
 * @param before 处理前字节数
 * @param after 处理后字节数
 * @returns 百分比文案；before 为 0 时返回 `--`
 * @example changeText(1000, 380) // '-62%'
 */
export function changeText(before: number, after: number): string {
  if (before <= 0) return '--'
  const pct = Math.round(((after - before) / before) * 100)
  return pct > 0 ? `+${pct}%` : `${pct}%`
}

/**
 * MIME 转扩展名（不带点）。
 *
 * @param mime 如 `image/jpeg`
 * @returns 如 `jpg`；未知时返回 `bin`
 */
export function mimeToExt(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? 'bin'
}

/**
 * 扩展名转 MIME（图片类）。
 *
 * @param name 文件名或扩展名
 * @returns MIME；未知时返回空串
 * @example extToMime('a.JPG') // 'image/jpeg'
 */
export function extToMime(name: string): string {
  const ext = (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name).toLowerCase()
  const hit = Object.keys(MIME_EXT).find((m) => MIME_EXT[m] === ext && m !== 'image/jpg')
  return hit ?? ''
}

/**
 * 去掉文件名扩展名。
 *
 * @param name 文件名
 * @returns 不含扩展名的部分；全是扩展名（如 `.png`）时原样返回
 */
export function baseName(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/**
 * 生成输出文件名：原名 + 后缀 + 实际格式的扩展名。
 *
 * @param name 原文件名
 * @param mime 输出 MIME
 * @param suffix 名字后缀，如 `-min`、`_1`
 * @example outputName('a.png', 'image/jpeg', '-min') // 'a-min.jpg'
 */
export function outputName(name: string, mime: string, suffix = ''): string {
  return `${baseName(name)}${suffix}.${mimeToExt(mime)}`
}

/** 网格单元：在源图上的裁剪矩形与行列号 */
export interface GridCell extends Rect {
  /** 序号，从 1 起，行优先 */
  index: number
  /** 行号，从 0 起 */
  row: number
  /** 列号，从 0 起 */
  col: number
}

/**
 * 计算切图网格。边界按四舍五入取整，相邻格无缝无重叠。
 *
 * @param width 源图宽
 * @param height 源图高
 * @param rows 行数
 * @param cols 列数
 * @param square 是否先居中裁成正方形
 * @returns 裁剪区域（相对源图）与各单元（坐标为源图坐标）
 * @example gridCells(300, 200, 1, 3, false).cells[1] // { x: 100, y: 0, w: 100, h: 200, ... }
 */
export function gridCells(
  width: number,
  height: number,
  rows: number,
  cols: number,
  square: boolean,
): { region: Rect; cells: GridCell[] } {
  const side = Math.min(width, height)
  const region: Rect = square
    ? { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), w: side, h: side }
    : { x: 0, y: 0, w: width, h: height }
  const cells: GridCell[] = []
  for (let r = 0; r < rows; r++) {
    const y0 = Math.round((r * region.h) / rows)
    const y1 = Math.round(((r + 1) * region.h) / rows)
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round((c * region.w) / cols)
      const x1 = Math.round(((c + 1) * region.w) / cols)
      cells.push({ index: r * cols + c + 1, row: r, col: c, x: region.x + x0, y: region.y + y0, w: x1 - x0, h: y1 - y0 })
    }
  }
  return { region, cells }
}

/** 拼接方向：v 纵向，h 横向 */
export type StitchDirection = 'v' | 'h'

/** 交叉轴对齐方式 */
export type StitchAlign = 'start' | 'center' | 'end'

/** 拼接参数 */
export interface StitchOptions {
  /** 方向 */
  direction: StitchDirection
  /** 图间距（像素） */
  gap: number
  /** 是否统一宽（纵拼）或统一高（横拼）为最窄/最矮的那张 */
  unify: boolean
  /** 不统一时交叉轴上的对齐方式 */
  align: StitchAlign
}

/** 拼接布局结果 */
export interface StitchLayout extends Size {
  /** 各图在画布上的目标矩形，顺序同输入 */
  items: Rect[]
}

/**
 * 计算拼接布局。
 *
 * @param sizes 各图原始尺寸（已按显示方向摆正）
 * @param opts 拼接参数
 * @returns 画布尺寸与各图目标矩形；空数组返回 0x0
 * @example stitchLayout([{width:100,height:50},{width:200,height:80}], {direction:'v',gap:10,unify:true,align:'start'})
 */
export function stitchLayout(sizes: Size[], opts: StitchOptions): StitchLayout {
  if (sizes.length === 0) return { width: 0, height: 0, items: [] }
  const vertical = opts.direction === 'v'
  // 交叉轴：纵拼是宽，横拼是高
  const cross = (s: Size) => (vertical ? s.width : s.height)
  const main = (s: Size) => (vertical ? s.height : s.width)
  const unifiedCross = Math.min(...sizes.map(cross))
  const scaled = sizes.map((s) => {
    const k = opts.unify ? unifiedCross / cross(s) : 1
    return { cross: Math.max(1, Math.round(cross(s) * k)), main: Math.max(1, Math.round(main(s) * k)) }
  })
  const crossTotal = Math.max(...scaled.map((s) => s.cross))
  const mainTotal = scaled.reduce((sum, s) => sum + s.main, 0) + opts.gap * (sizes.length - 1)
  let pos = 0
  const items = scaled.map((s) => {
    const free = crossTotal - s.cross
    const off = opts.align === 'start' ? 0 : opts.align === 'center' ? Math.floor(free / 2) : free
    const rect: Rect = vertical ? { x: off, y: pos, w: s.cross, h: s.main } : { x: pos, y: off, w: s.main, h: s.cross }
    pos += s.main + opts.gap
    return rect
  })
  return vertical ? { width: crossTotal, height: mainTotal, items } : { width: mainTotal, height: crossTotal, items }
}
