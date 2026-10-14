// 打字板：全屏大字静止显示，字号自适应、配色预设

/** 文字长度上限 */
export const TEXT_MAX = 200
/** 字号下限（像素） */
export const FONT_MIN = 16
/** 字号上限（像素） */
export const FONT_MAX = 600
/** 闪烁频率下限（Hz） */
export const BLINK_HZ_MIN = 0.5
/** 闪烁频率上限（Hz） */
export const BLINK_HZ_MAX = 2
/** 粗细可选值 */
export const WEIGHTS = [400, 700, 900] as const
/** 对齐方式 */
export type Align = 'left' | 'center' | 'right'

/** 配色预设 */
export interface Preset {
  /** 名称 */
  name: string
  /** 字色 */
  fg: string
  /** 背景色 */
  bg: string
  /** 默认文字 */
  text: string
}

/** 高对比配色预设：接机、应援、公告等 */
export const PRESETS: readonly Preset[] = [
  { name: '接机', fg: '#000000', bg: '#ffeb3b', text: '请问是 ×× 吗' },
  { name: '应援', fg: '#ffffff', bg: '#e91e63', text: '加油！' },
  { name: '公告', fg: '#ffffff', bg: '#1565c0', text: '请稍候' },
  { name: '夜间', fg: '#76ff03', bg: '#000000', text: 'HELLO' },
  { name: '黑白', fg: '#ffffff', bg: '#000000', text: '你好' },
]

/**
 * 测量函数：给定字号与容器宽度，返回文字排版后的总高度（像素）。
 * 浏览器里用隐藏节点量；单测里注入假实现。
 */
export type MeasureFn = (fontSize: number, width: number) => number

/**
 * 二分求能放进容器的最大字号。
 *
 * @param width 容器宽度
 * @param height 容器高度
 * @param measure 测量函数，返回该字号下文字总高度
 * @param min 字号下限，缺省 FONT_MIN
 * @param max 字号上限，缺省 FONT_MAX
 * @returns 整数字号，落在 [min, max]；连下限都放不下时返回下限
 * @example fitFontSize(400, 300, (fs, w) => fs * 2) // 150
 */
export function fitFontSize(width: number, height: number, measure: MeasureFn, min = FONT_MIN, max = FONT_MAX): number {
  if (width <= 0 || height <= 0) return min
  let lo = min
  let hi = max
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(mid, width) <= height) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * 限制数值范围，非有限数取下限。
 *
 * @param n 输入值
 * @param min 下限
 * @param max 上限
 * @returns 夹取后的值
 * @example clampNum(5, 0, 3) // 3
 */
export function clampNum(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/**
 * 闪烁一个完整周期的秒数。
 *
 * @param hz 频率，会被夹到 0.5~2
 * @returns 周期秒数
 * @example blinkPeriod(2) // 0.5
 */
export function blinkPeriod(hz: number): number {
  return 1 / clampNum(hz, BLINK_HZ_MIN, BLINK_HZ_MAX)
}

/**
 * 整理输入文字：统一换行符并截断到上限。
 *
 * @param s 原始文字
 * @returns 整理后的文字
 * @example cleanText('a\r\nb') // 'a\nb'
 */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, '\n').slice(0, TEXT_MAX)
}

/**
 * 反色：把 #rrggbb 取反。
 *
 * @param hex 形如 #rrggbb 的颜色
 * @returns 反色后的 #rrggbb；格式不对时原样返回
 * @example invertColor('#000000') // '#ffffff'
 */
export function invertColor(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const v = 0xffffff - parseInt(m[1], 16)
  return '#' + v.toString(16).padStart(6, '0')
}
