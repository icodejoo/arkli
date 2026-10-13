// 手持弹幕：参数钳制、滚动时长、最近文案（与 Vue 解耦）

/** 字号范围（像素） */
export const FONT_MIN = 40
/** 字号上限（像素） */
export const FONT_MAX = 320
/** 默认字号 */
export const FONT_DEFAULT = 160
/** 速度范围（像素/秒） */
export const SPEED_MIN = 40
/** 速度上限（像素/秒） */
export const SPEED_MAX = 800
/** 默认速度 */
export const SPEED_DEFAULT = 240
/** 文案最大长度 */
export const TEXT_MAX = 100
/** 最近文案保留条数 */
export const RECENT_MAX = 6
/** 最近文案的存储键 */
export const RECENT_KEY = 'arkli:danmaku:recent'
/** 默认文案 */
export const DEFAULT_TEXT = '欢迎光临'
/** 文字颜色预设：[色值, 名称] */
export const TEXT_COLORS: ReadonlyArray<readonly [string, string]> = [
  ['#ffffff', '白'],
  ['#ffe600', '黄'],
  ['#39ff14', '绿'],
  ['#ff3b30', '红'],
  ['#00d4ff', '青'],
  ['#ff4fd8', '粉'],
]
/** 背景颜色预设：[色值, 名称] */
export const BG_COLORS: ReadonlyArray<readonly [string, string]> = [
  ['#000000', '黑'],
  ['#0a1a8c', '深蓝'],
  ['#b00020', '深红'],
  ['#0b5d1e', '深绿'],
  ['#ffffff', '白'],
]
/** 闪烁周期（秒） */
export const BLINK_SEC = 0.8

/** 键值存储的最小接口 */
export interface KvStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * 把数字限制在 [min, max]，非数字取 fallback。
 *
 * @param v 输入值
 * @param min 下限
 * @param max 上限
 * @param fallback 非有限数时的兜底
 * @returns 钳制后的数
 * @example
 * clampNum(999, 40, 320, 160) // 320
 */
export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 整理要显示的文案：去首尾空白、换行改空格、截断超长部分；空文案用默认文案。
 *
 * @param raw 用户输入
 * @returns 可显示的非空文案
 * @example
 * cleanText('  hi\nthere ') // 'hi there'
 */
export function cleanText(raw: string): string {
  const t = Array.from(raw.replace(/\s+/g, ' ').trim()).slice(0, TEXT_MAX).join('')
  return t || DEFAULT_TEXT
}

/**
 * 算一圈滚动要多少秒：文字从屏幕右侧外滚到左侧外。
 *
 * @param textWidth 文字宽度（像素）
 * @param viewWidth 屏幕宽度（像素）
 * @param speed 速度（像素/秒）
 * @returns 秒数；入参非法时返回 0
 * @example
 * scrollDuration(400, 600, 200) // 5
 */
export function scrollDuration(textWidth: number, viewWidth: number, speed: number): number {
  if (!(textWidth >= 0) || !(viewWidth > 0) || !(speed > 0)) return 0
  return (textWidth + viewWidth) / speed
}

/**
 * 把新文案放到最近列表最前，去重并限制条数。
 *
 * @param list 现有列表
 * @param text 新文案
 * @param max 最多保留条数
 * @returns 新列表（不修改入参）
 */
export function pushRecent(list: readonly string[], text: string, max = RECENT_MAX): string[] {
  const t = text.trim()
  if (!t) return [...list]
  return [t, ...list.filter((x) => x !== t)].slice(0, max)
}

/**
 * 读最近文案。
 *
 * @param storage 存储对象
 * @returns 字符串数组；没有、损坏或存储不可用时为空数组
 */
export function loadRecent(storage: KvStorage | undefined): string[] {
  try {
    const raw = storage?.getItem(RECENT_KEY)
    if (!raw) return []
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

/**
 * 存最近文案；失败时静默。
 *
 * @param storage 存储对象
 * @param list 要保存的列表
 */
export function saveRecent(storage: KvStorage | undefined, list: readonly string[]): void {
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)))
  } catch {
    // 存储满了或被禁用，忽略
  }
}
