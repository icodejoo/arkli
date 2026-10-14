// 抛硬币：纯逻辑，先定结果再播动画
import { randomInt, type RandomSource, cryptoSource } from '@/shared/random'

/** 硬币面：正面 / 反面 */
export type CoinSide = 'heads' | 'tails'

/** 单次最多连抛次数 */
export const MAX_FLIPS = 20

/** 面的中文名 */
export const SIDE_LABEL: Record<CoinSide, string> = { heads: '正面', tails: '反面' }

/**
 * 抛一次硬币。
 *
 * @param src 随机源
 * @returns 'heads' 或 'tails'
 * @example
 * flipCoin() // 'heads'
 */
export function flipCoin(src: RandomSource = cryptoSource): CoinSide {
  return randomInt(0, 1, src) === 0 ? 'heads' : 'tails'
}

/**
 * 连抛 n 次。
 *
 * @param n 次数（1 ~ MAX_FLIPS）
 * @param src 随机源
 * @returns 每次的结果
 * @throws RangeError n 越界
 * @example
 * flipCoins(3) // ['heads', 'tails', 'tails']
 */
export function flipCoins(n: number, src: RandomSource = cryptoSource): CoinSide[] {
  if (!Number.isInteger(n) || n < 1 || n > MAX_FLIPS) throw new RangeError('次数越界')
  return Array.from({ length: n }, () => flipCoin(src))
}

/**
 * 统计正反面个数。
 *
 * @param results 结果列表
 * @returns 各面个数
 * @example
 * countSides(['heads', 'tails', 'heads']) // { heads: 2, tails: 1 }
 */
export function countSides(results: readonly CoinSide[]): Record<CoinSide, number> {
  const out: Record<CoinSide, number> = { heads: 0, tails: 0 }
  for (const r of results) out[r]++
  return out
}

/** 抛出时的震动节奏（毫秒，`[停, 震, ...]`），短促一下 */
export const VIBRATE_START: readonly number[] = [0, 30]
/** 落定时的震动节奏，轻轻两下 */
export const VIBRATE_LAND: readonly number[] = [0, 20, 40, 20]
/** 震动开关的存储键 */
export const VIBRATE_KEY = 'arkli:feedback:vibrate'
/** 音效开关的存储键 */
export const SOUND_KEY = 'arkli:feedback:sound'
/** 包络最低增益（指数衰减不能到 0） */
export const MIN_GAIN = 0.0001

/** 反馈事件：抛出 / 落定 */
export type FeedbackKind = 'start' | 'land'

/** 一个音符的合成参数 */
export interface ToneSpec {
  /** 相对触发时刻的起点（毫秒） */
  startMs: number
  /** 频率（Hz） */
  freq: number
  /** 时长（毫秒） */
  durMs: number
  /** 峰值增益 0~1 */
  peak: number
  /** 起音时间（毫秒） */
  attackMs: number
  /** 波形 */
  type: 'sine' | 'triangle' | 'square'
}

/** 抛出的「咔哒」：很短的方波点击 */
const TONE_START: ToneSpec[] = [{ startMs: 0, freq: 1800, durMs: 35, peak: 0.12, attackMs: 2, type: 'square' }]
/** 落定的「叮」：两个叠起来的正弦，高音略短 */
const TONE_LAND: ToneSpec[] = [
  { startMs: 0, freq: 1320, durMs: 220, peak: 0.2, attackMs: 4, type: 'sine' },
  { startMs: 0, freq: 2640, durMs: 120, peak: 0.08, attackMs: 4, type: 'sine' },
]

/**
 * 取某个反馈事件的合成参数。
 *
 * @param kind 事件：`start` 抛出 / `land` 落定
 * @returns 音符列表（新数组，可随意改）
 * @example
 * toneSpecs('land')[0].freq // 1320
 */
export function toneSpecs(kind: FeedbackKind): ToneSpec[] {
  return (kind === 'start' ? TONE_START : TONE_LAND).map((t) => ({ ...t }))
}

/** 包络上的一个控制点 */
export interface EnvPoint {
  /** 相对音符起点的时间（秒） */
  t: number
  /** 增益 */
  v: number
  /** 到达方式：linear 线性 / exp 指数 */
  ramp: 'linear' | 'exp'
}

/**
 * 算音符的增益包络：从最低增益线性升到峰值，再指数衰减回最低。
 *
 * @param spec 音符参数
 * @returns 控制点（时间单位秒），首点为起点
 * @example
 * envelopePoints({ startMs: 0, freq: 1000, durMs: 100, peak: 0.2, attackMs: 5, type: 'sine' })
 * // [{t:0,v:0.0001,ramp:'linear'},{t:0.005,v:0.2,ramp:'linear'},{t:0.1,v:0.0001,ramp:'exp'}]
 */
export function envelopePoints(spec: ToneSpec): EnvPoint[] {
  const total = Math.max(spec.durMs, 1)
  const attack = Math.min(Math.max(spec.attackMs, 0), total / 2)
  const peak = Math.min(Math.max(spec.peak, MIN_GAIN), 1)
  return [
    { t: 0, v: MIN_GAIN, ramp: 'linear' },
    { t: attack / 1000, v: peak, ramp: 'linear' },
    { t: total / 1000, v: MIN_GAIN, ramp: 'exp' },
  ]
}

/** 最小存储结构 */
export interface BoolStorage {
  /** 读 */
  getItem(key: string): string | null
  /** 写 */
  setItem(key: string, value: string): void
}

/**
 * 读布尔开关；没存过、存储不可用都回退默认值。
 *
 * @param storage 存储对象，可缺省
 * @param key 键
 * @param fallback 默认值
 * @returns 开关值
 * @example
 * loadFlag(localStorage, VIBRATE_KEY, true)
 */
export function loadFlag(storage: BoolStorage | undefined, key: string, fallback: boolean): boolean {
  try {
    const raw = storage?.getItem(key)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    // 存储不可用时用默认值
  }
  return fallback
}

/**
 * 存布尔开关；存储不可用时静默忽略。
 *
 * @param storage 存储对象，可缺省
 * @param key 键
 * @param value 开关值
 * @example
 * saveFlag(localStorage, SOUND_KEY, false)
 */
export function saveFlag(storage: BoolStorage | undefined, key: string, value: boolean): void {
  try {
    storage?.setItem(key, value ? '1' : '0')
  } catch {
    // 存储不可用时忽略
  }
}
