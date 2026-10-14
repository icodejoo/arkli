/**
 * 图片水印的纯逻辑：字号换算、旋转包围盒、九宫格定位、整图平铺坐标。
 * 不碰 DOM，可直接单测。
 */

/** 字号最小像素，太小看不清 */
export const FONT_MIN_PX = 8
/** 单个水印距边的留白占短边的比例 */
export const MARGIN_RATIO = 0.03
/** 平铺水印数量上限，防止参数极端时卡死 */
export const MAX_TILES = 4000
/** 文字行高相对字号的倍数 */
export const LINE_HEIGHT_RATIO = 1.2
/** 九宫格格数 */
export const GRID_COUNT = 9

/** 水印模式：single 单个定位，tile 整图平铺 */
export type WatermarkMode = 'single' | 'tile'

/** 坐标点 */
export interface Point {
  /** 横坐标 */
  x: number
  /** 纵坐标 */
  y: number
}

/** 水印布局参数 */
export interface LayoutOptions {
  /** 模式 */
  mode: WatermarkMode
  /** 单个模式的九宫格位置 0~8（行优先：0 左上，4 居中，8 右下） */
  position: number
  /** 旋转角度（度，顺时针为正） */
  rotation: number
  /** 平铺横向间距（占字号的百分比） */
  gapX: number
  /** 平铺纵向间距（占字号的百分比） */
  gapY: number
  /** 平铺时奇数行是否错开半格 */
  stagger: boolean
}

/**
 * 按短边百分比换算字号，保证横图竖图上视觉大小一致。
 *
 * @param width 图宽
 * @param height 图高
 * @param percent 字号占短边的百分比
 * @returns 字号（像素，整数，不小于 FONT_MIN_PX）
 * @example fontPx(1000, 2000, 5) // 50
 */
export function fontPx(width: number, height: number, percent: number): number {
  return Math.max(FONT_MIN_PX, Math.round((Math.min(width, height) * percent) / 100))
}

/**
 * 把值限制在区间内，非数字按下限处理。
 *
 * @param v 值
 * @param min 下限
 * @param max 上限
 * @example clamp(5, 0, 1) // 1
 */
export function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  return Math.min(max, Math.max(min, v))
}

/**
 * 矩形旋转后的外接盒尺寸。
 *
 * @param w 宽
 * @param h 高
 * @param deg 旋转角度（度）
 * @returns 外接盒宽高
 * @example rotatedBox(100, 20, 90) // { w: 20, h: 100 }（有浮点误差）
 */
export function rotatedBox(w: number, h: number, deg: number): { w: number; h: number } {
  const rad = (deg * Math.PI) / 180
  const c = Math.abs(Math.cos(rad))
  const s = Math.abs(Math.sin(rad))
  return { w: w * c + h * s, h: w * s + h * c }
}

/**
 * 九宫格定位：返回水印中心点，保证旋转后的外接盒整体落在画布内（留白 margin）。
 * 画布放不下时盒子居中。
 *
 * @param position 0~8，行优先（0 左上、1 上中、2 右上、…、8 右下）；越界按居中
 * @param canvasW 画布宽
 * @param canvasH 画布高
 * @param boxW 水印外接盒宽（已含旋转）
 * @param boxH 水印外接盒高
 * @param margin 距边留白
 * @returns 中心点
 * @example anchorCenter(0, 1000, 800, 200, 100, 20) // { x: 120, y: 70 }
 */
export function anchorCenter(position: number, canvasW: number, canvasH: number, boxW: number, boxH: number, margin: number): Point {
  const p = position >= 0 && position < GRID_COUNT ? Math.floor(position) : 4
  const col = p % 3
  const row = Math.floor(p / 3)
  const axis = (idx: number, canvas: number, box: number) => {
    const lo = margin + box / 2
    const hi = canvas - margin - box / 2
    if (lo > hi) return canvas / 2
    return idx === 0 ? lo : idx === 1 ? canvas / 2 : hi
  }
  return { x: axis(col, canvasW, boxW), y: axis(row, canvasH, boxH) }
}

/**
 * 整图平铺：在以画布中心为原点、随水印一起旋转的网格上取点，旋转后铺满整个画布，
 * 只保留外接盒会与画布相交的点。
 *
 * @param canvasW 画布宽
 * @param canvasH 画布高
 * @param cellW 单格宽（文字宽 + 横向间距）
 * @param cellH 单格高（文字高 + 纵向间距）
 * @param deg 旋转角度（度）
 * @param stagger 奇数行是否错开半格
 * @param reach 外接盒半对角线，用来判断边缘点是否仍会露出一部分
 * @returns 各水印中心点，最多 MAX_TILES 个
 * @example tileCenters(1000, 1000, 200, 100, 0, false, 100).length
 */
export function tileCenters(
  canvasW: number,
  canvasH: number,
  cellW: number,
  cellH: number,
  deg: number,
  stagger: boolean,
  reach: number,
): Point[] {
  const cw = Math.max(1, cellW)
  const ch = Math.max(1, cellH)
  const cx = canvasW / 2
  const cy = canvasH / 2
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // 网格要覆盖到画布外接圆
  const radius = Math.hypot(canvasW, canvasH) / 2 + reach
  const rows = Math.ceil(radius / ch)
  const cols = Math.ceil(radius / cw) + 1
  const out: Point[] = []
  for (let j = -rows; j <= rows; j++) {
    const shift = stagger && Math.abs(j) % 2 === 1 ? cw / 2 : 0
    for (let i = -cols; i <= cols; i++) {
      const u = i * cw + shift
      const v = j * ch
      const x = cx + u * cos - v * sin
      const y = cy + u * sin + v * cos
      if (x < -reach || y < -reach || x > canvasW + reach || y > canvasH + reach) continue
      out.push({ x, y })
      if (out.length >= MAX_TILES) return out
    }
  }
  return out
}

/**
 * 综合布局：给定文字尺寸，算出所有水印中心点。
 *
 * @param canvasW 画布宽
 * @param canvasH 画布高
 * @param textW 文字宽（未旋转）
 * @param fontSize 字号，行高取 fontSize × LINE_HEIGHT_RATIO
 * @param opts 布局参数
 * @returns 水印中心点列表（单个模式只有一个）
 * @example layoutWatermark(1000, 800, 200, 40, { mode: 'single', position: 4, rotation: 0, gapX: 50, gapY: 50, stagger: false })
 */
export function layoutWatermark(canvasW: number, canvasH: number, textW: number, fontSize: number, opts: LayoutOptions): Point[] {
  const textH = fontSize * LINE_HEIGHT_RATIO
  if (opts.mode === 'single') {
    const box = rotatedBox(textW, textH, opts.rotation)
    const margin = Math.min(canvasW, canvasH) * MARGIN_RATIO
    return [anchorCenter(opts.position, canvasW, canvasH, box.w, box.h, margin)]
  }
  const cellW = textW + (fontSize * opts.gapX) / 100
  const cellH = textH + (fontSize * opts.gapY) / 100
  return tileCenters(canvasW, canvasH, cellW, cellH, opts.rotation, opts.stagger, Math.hypot(textW, textH) / 2)
}
