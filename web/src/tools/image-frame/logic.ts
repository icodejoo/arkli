import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, type Rect } from '@/shared/image-calc'

/** 外壳样式：手机壳 / 浏览器窗口 / 纯卡片 */
export type FrameStyle = 'phone' | 'browser' | 'card'
/** 手机壳的屏幕缺口：无 / 刘海 / 挖孔 */
export type CutoutKind = 'none' | 'notch' | 'punch'

/** 排版参数（长度类一律按截图宽度的百分比，换分辨率不用重调） */
export interface FrameOptions {
  /** 外壳样式 */
  style: FrameStyle
  /** 四周边距，占截图宽度的百分比 */
  padPct: number
  /** 外壳圆角，占截图宽度的百分比 */
  radiusPct: number
  /** 手机壳缺口 */
  cutout: CutoutKind
}

/** 圆形（浏览器三点、挖孔） */
export interface Dot {
  /** 圆心 x */
  x: number
  /** 圆心 y */
  y: number
  /** 半径 */
  r: number
}

/** 浏览器顶栏布局 */
export interface BarLayout {
  /** 顶栏矩形 */
  rect: Rect
  /** 三个圆点 */
  dots: Dot[]
  /** 地址栏胶囊 */
  pill: Rect
}

/** 刘海 / 挖孔布局 */
export interface CutoutLayout {
  /** 类型 */
  kind: 'notch' | 'punch'
  /** 刘海矩形（punch 时为包围盒） */
  rect: Rect
  /** 挖孔圆（仅 punch） */
  dot?: Dot
}

/** 阴影参数 */
export interface ShadowSpec {
  /** 模糊半径 */
  blur: number
  /** 纵向偏移 */
  offsetY: number
}

/** 完整布局，所有坐标已是最终画布像素 */
export interface FrameLayout {
  /** 画布宽 */
  width: number
  /** 画布高 */
  height: number
  /** 因画布上限而对截图做的缩放（1 表示原尺寸） */
  scale: number
  /** 外壳矩形 */
  device: Rect
  /** 外壳圆角 */
  deviceRadius: number
  /** 截图落点 */
  screen: Rect
  /** 截图圆角（浏览器样式下为 0，由外壳裁剪） */
  screenRadius: number
  /** 阴影 */
  shadow: ShadowSpec
  /** 浏览器顶栏，仅 browser 样式 */
  bar?: BarLayout
  /** 缺口，仅 phone 样式且选了缺口 */
  cutout?: CutoutLayout
}

/** 手机黑边宽度占截图宽度比例 */
const BEZEL_RATIO = 0.035
/** 黑边最小像素 */
const BEZEL_MIN = 6
/** 浏览器顶栏高度占宽度比例 */
const BAR_RATIO = 0.06
/** 顶栏最小高度 */
const BAR_MIN = 32
/** 阴影模糊占宽度比例 */
const SHADOW_BLUR_RATIO = 0.04
/** 阴影纵向偏移占宽度比例 */
const SHADOW_OFFSET_RATIO = 0.02
/** 刘海宽 / 高 / 挖孔半径，占截图宽度比例 */
const NOTCH_W_RATIO = 0.34
const NOTCH_H_RATIO = 0.04
const PUNCH_R_RATIO = 0.018
/** 挖孔圆心距屏幕顶的距离占宽度比例 */
const PUNCH_TOP_RATIO = 0.036
/** 顶栏圆点半径占顶栏高度比例，相邻圆心间距 / 起始偏移（占顶栏高度） */
const DOT_R_RATIO = 0.14
const DOT_GAP_RATIO = 0.42
const DOT_START_RATIO = 0.55
/** 地址栏胶囊：左边距离（占顶栏高）、高度占比、宽度占整体宽比例 */
const PILL_LEFT_RATIO = 2.3
const PILL_H_RATIO = 0.6
const PILL_RIGHT_RATIO = 0.6
/** 缩放时多留的余量，抵消边距取整带来的 1px 误差 */
const SCALE_MARGIN = 0.99
/** 渐变角度默认值 */
export const DEFAULT_ANGLE = 135

/** 背景预设 */
export interface BgPreset {
  /** 名称 */
  name: string
  /** 起始色 */
  c1: string
  /** 结束色，与 c1 相同即纯色 */
  c2: string
}

/** 常用背景预设 */
export const BG_PRESETS: BgPreset[] = [
  { name: '极光', c1: '#667eea', c2: '#764ba2' },
  { name: '日落', c1: '#f093fb', c2: '#f5576c' },
  { name: '海湾', c1: '#4facfe', c2: '#00f2fe' },
  { name: '薄荷', c1: '#43e97b', c2: '#38f9d7' },
  { name: '暖阳', c1: '#fa709a', c2: '#fee140' },
  { name: '浅灰', c1: '#f2f3f5', c2: '#f2f3f5' },
  { name: '深夜', c1: '#232526', c2: '#414345' },
]

/**
 * 夹住圆角半径，不超过短边的一半。
 *
 * @param r 期望半径
 * @param w 宽
 * @param h 高
 * @returns 合法半径（整数，不小于 0）
 * @example clampRadius(100, 40, 60) // 20
 */
export function clampRadius(r: number, w: number, h: number): number {
  return Math.max(0, Math.min(Math.round(r), Math.floor(Math.min(w, h) / 2)))
}

/**
 * 渐变线两端坐标（角度 0 为从下往上，90 为从左往右，同 CSS linear-gradient），覆盖整个矩形。
 *
 * @param w 画布宽
 * @param h 画布高
 * @param angleDeg 角度（度）
 * @returns 起止点
 * @example gradientLine(100, 100, 90) // { x0: 0, y0: 50, x1: 100, y1: 50 }
 */
export function gradientLine(w: number, h: number, angleDeg: number): { x0: number; y0: number; x1: number; y1: number } {
  const rad = (angleDeg * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad)
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2
  const cx = w / 2
  const cy = h / 2
  const round = (n: number) => Math.round(n * 1e6) / 1e6
  return { x0: round(cx - dx * half), y0: round(cy - dy * half), x1: round(cx + dx * half), y1: round(cy + dy * half) }
}

/** 按画布上限算缩放系数：超过单边或总像素上限时 <1 */
function limitScale(width: number, height: number): number {
  const bySide = Math.min(1, MAX_CANVAS_SIDE / Math.max(width, height))
  const byArea = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)))
  return Math.min(bySide, byArea)
}

/** 不考虑上限的布局（scale 恒为 1） */
function rawLayout(imgW: number, imgH: number, opts: FrameOptions): FrameLayout {
  const base = imgW
  const pad = Math.round((base * opts.padPct) / 100)
  const bezel = opts.style === 'phone' ? Math.max(BEZEL_MIN, Math.round(base * BEZEL_RATIO)) : 0
  const barH = opts.style === 'browser' ? Math.max(BAR_MIN, Math.round(base * BAR_RATIO)) : 0
  const devW = imgW + bezel * 2
  const devH = imgH + bezel * 2 + barH
  const device: Rect = { x: pad, y: pad, w: devW, h: devH }
  const deviceRadius = clampRadius((base * opts.radiusPct) / 100, devW, devH)
  const screen: Rect = { x: pad + bezel, y: pad + bezel + barH, w: imgW, h: imgH }
  const layout: FrameLayout = {
    width: devW + pad * 2,
    height: devH + pad * 2,
    scale: 1,
    device,
    deviceRadius,
    screen,
    screenRadius: opts.style === 'phone' ? clampRadius(deviceRadius - bezel, imgW, imgH) : opts.style === 'card' ? deviceRadius : 0,
    shadow: { blur: Math.round(base * SHADOW_BLUR_RATIO), offsetY: Math.round(base * SHADOW_OFFSET_RATIO) },
  }
  if (opts.style === 'browser') {
    const rect: Rect = { x: device.x, y: device.y, w: devW, h: barH }
    const cy = rect.y + barH / 2
    const r = Math.round(barH * DOT_R_RATIO * 100) / 100
    const dots = [0, 1, 2].map((i) => ({ x: rect.x + barH * (DOT_START_RATIO + DOT_GAP_RATIO * i), y: cy, r }))
    const pillH = Math.round(barH * PILL_H_RATIO)
    const pillX = Math.round(rect.x + barH * PILL_LEFT_RATIO)
    layout.bar = {
      rect,
      dots,
      pill: { x: pillX, y: Math.round(cy - pillH / 2), w: Math.max(0, Math.round(rect.x + devW - barH * PILL_RIGHT_RATIO) - pillX), h: pillH },
    }
  }
  if (opts.style === 'phone' && opts.cutout !== 'none') {
    const cx = screen.x + screen.w / 2
    if (opts.cutout === 'notch') {
      const w = Math.round(base * NOTCH_W_RATIO)
      layout.cutout = { kind: 'notch', rect: { x: Math.round(cx - w / 2), y: screen.y, w, h: Math.round(base * NOTCH_H_RATIO) } }
    } else {
      const r = Math.max(2, Math.round(base * PUNCH_R_RATIO))
      const cy = Math.round(screen.y + base * PUNCH_TOP_RATIO)
      layout.cutout = { kind: 'punch', rect: { x: Math.round(cx - r), y: cy - r, w: r * 2, h: r * 2 }, dot: { x: cx, y: cy, r } }
    }
  }
  return layout
}

/**
 * 计算套壳后的整体布局。超出画布上限时，整体等比缩小截图再排版，scale 里给出缩放系数。
 *
 * @param imgW 截图宽
 * @param imgH 截图高
 * @param opts 排版参数
 * @returns 画布尺寸与各元素落点（像素）
 * @example
 * const l = frameLayout(1080, 2400, { style: 'phone', padPct: 8, radiusPct: 6, cutout: 'punch' })
 * l.width // 画布宽
 */
export function frameLayout(imgW: number, imgH: number, opts: FrameOptions): FrameLayout {
  const first = rawLayout(imgW, imgH, opts)
  const s = limitScale(first.width, first.height)
  if (s >= 1) return first
  const w = Math.max(1, Math.floor(imgW * s * SCALE_MARGIN))
  const h = Math.max(1, Math.floor(imgH * s * SCALE_MARGIN))
  return { ...rawLayout(w, h, opts), scale: w / imgW }
}
