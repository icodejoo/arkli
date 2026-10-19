// 屏幕测试：纯色/灰阶循环与触摸格子点亮统计（与 Vue 解耦）

/** 一个测试画面 */
export interface Screen {
  /** 名称 */
  name: string
  /** CSS 背景 */
  background: string
  /** 提示文字是否用浅色 */
  light: boolean
}

/** 触摸测试的列数 */
export const TOUCH_COLS = 8
/** 触摸测试的行数 */
export const TOUCH_ROWS = 14

/** 测试画面顺序：红绿蓝白黑灰阶 */
export const SCREENS: readonly Screen[] = [
  { name: '纯红', background: '#ff0000', light: true },
  { name: '纯绿', background: '#00ff00', light: false },
  { name: '纯蓝', background: '#0000ff', light: true },
  { name: '纯白', background: '#ffffff', light: false },
  { name: '纯黑', background: '#000000', light: true },
  { name: '灰阶渐变', background: 'linear-gradient(to right, #000, #fff)', light: true },
]

/**
 * 下一个画面下标（循环）。
 *
 * @param i 当前下标
 * @param step 步长，1 下一个，-1 上一个
 * @returns 新下标
 * @example nextScreen(5) // 0
 */
export function nextScreen(i: number, step = 1): number {
  const n = SCREENS.length
  return (((i + step) % n) + n) % n
}

/**
 * 坐标换算成格子下标；落在区域外返回 -1。
 *
 * @param x 相对区域左上角的横坐标
 * @param y 相对区域左上角的纵坐标
 * @param w 区域宽
 * @param h 区域高
 * @param cols 列数
 * @param rows 行数
 * @returns 格子下标（行优先）或 -1
 * @example cellIndex(5, 5, 80, 140, 8, 14) // 0
 */
export function cellIndex(x: number, y: number, w: number, h: number, cols = TOUCH_COLS, rows = TOUCH_ROWS): number {
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x >= w || y >= h) return -1
  return Math.floor(y / (h / rows)) * cols + Math.floor(x / (w / cols))
}

/**
 * 点亮覆盖率。
 *
 * @param lit 已点亮格子数
 * @param total 总格数
 * @returns 0~100 的整数百分比
 * @example coverage(14, 112) // 13
 */
export function coverage(lit: number, total = TOUCH_COLS * TOUCH_ROWS): number {
  return total > 0 ? Math.round((Math.min(lit, total) / total) * 100) : 0
}
