// 打字板（含原手持弹幕）：全屏大字展示，文字没超出屏幕就静止，超出就横向滚动；配色预设、闪烁、最近文案（与 Vue 解耦）

/** 文字长度上限 */
export const TEXT_MAX = 200
/** 默认文案（输入为空时用） */
export const DEFAULT_TEXT = '你好'
/** 字号下限（像素） */
export const FONT_MIN = 24
/** 字号上限（像素） */
export const FONT_MAX = 400
/** 默认字号 */
export const FONT_DEFAULT = 160
/** 滚动速度下限（像素/秒） */
export const SPEED_MIN = 40
/** 滚动速度上限（像素/秒） */
export const SPEED_MAX = 800
/** 默认滚动速度 */
export const SPEED_DEFAULT = 240
/** 闪烁频率下限（Hz） */
export const BLINK_HZ_MIN = 0.5
/** 闪烁频率上限（Hz） */
export const BLINK_HZ_MAX = 2
/** 粗细可选值 */
export const WEIGHTS = [400, 700, 900] as const
/** 展示层四周留白（像素）：文字宽度超过「屏宽 - 两侧留白」才算超出 */
export const STAGE_PAD = 16
/** 最近文案保留条数 */
export const RECENT_MAX = 6
/** 最近文案的存储键（沿用原手持弹幕的键，历史记录不丢） */
export const RECENT_KEY = 'arkli:danmaku:recent'
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

/** 键值存储的最小接口 */
export interface KvStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
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
 * 整理要显示的文案：空白（含换行）合并成一个空格、去首尾空白、截断超长部分；空文案用默认文案。
 *
 * @param raw 用户输入
 * @returns 可显示的非空单行文案
 * @example cleanText('  hi\nthere ') // 'hi there'
 */
export function cleanText(raw: string): string {
  const t = Array.from(raw.replace(/\s+/g, ' ').trim()).slice(0, TEXT_MAX).join('')
  return t || DEFAULT_TEXT
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

/**
 * 文字是否超出屏幕：单行宽度大于「屏宽 - 两侧留白」就要滚动。
 *
 * @param textWidth 单行文字宽度（像素）
 * @param viewWidth 屏幕宽度（像素）
 * @param pad 单侧留白，默认 {@link STAGE_PAD}
 * @returns 超出为 true；宽度无效按没超出处理
 * @example overflows(400, 360) // true
 */
export function overflows(textWidth: number, viewWidth: number, pad = STAGE_PAD): boolean {
  if (!(textWidth > 0) || !(viewWidth > 0)) return false
  return textWidth > viewWidth - pad * 2
}

/**
 * 算一圈滚动要多少秒：文字从屏幕右侧外滚到左侧外。
 *
 * @param textWidth 文字宽度（像素）
 * @param viewWidth 屏幕宽度（像素）
 * @param speed 速度（像素/秒）
 * @returns 秒数；入参非法时返回 0
 * @example scrollDuration(400, 600, 200) // 5
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
