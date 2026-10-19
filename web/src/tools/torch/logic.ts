// 手电筒：SOS 时序表与频闪频率换算（纯逻辑，页面用定时器驱动）

/** 摩斯一个单位的毫秒数 */
export const UNIT_MS = 200
/** 点占几个单位 */
const DOT_UNITS = 1
/** 划占几个单位 */
const DASH_UNITS = 3
/** 同一字母内部间隔的单位数 */
const SYMBOL_GAP_UNITS = 1
/** 字母之间间隔的单位数 */
const LETTER_GAP_UNITS = 3
/** 一轮 SOS 结束到下一轮开始的间隔单位数 */
const WORD_GAP_UNITS = 7
/** 频闪最低频率（Hz） */
export const MIN_STROBE_HZ = 1
/** 频闪最高频率（Hz）：3Hz 以内低于光敏性癫痫的常见诱发区间（约 3~30Hz 风险最高），闪光灯本身也受硬件响应限制 */
export const MAX_STROBE_HZ = 3
/** 频闪默认频率（Hz） */
export const DEFAULT_STROBE_HZ = 2
/** 毫秒每秒 */
const MS_PER_S = 1000

/** 时序里的一步：亮或灭持续多久 */
export interface TorchStep {
  /** 这一步灯是否亮 */
  on: boolean
  /** 持续毫秒 */
  ms: number
}

/** SOS 三个字母：点点点、划划划、点点点 */
const SOS_LETTERS = [
  [DOT_UNITS, DOT_UNITS, DOT_UNITS],
  [DASH_UNITS, DASH_UNITS, DASH_UNITS],
  [DOT_UNITS, DOT_UNITS, DOT_UNITS],
]

/**
 * 生成一轮 SOS 时序（短短短长长长短短短），结尾带一段长间隔，可直接循环。
 *
 * @param unitMs 一个摩斯单位的毫秒数，默认 {@link UNIT_MS}
 * @returns 亮灭交替的步骤，首步为亮，末步为灭
 * @example sosSteps() // [{ on: true, ms: 200 }, { on: false, ms: 200 }, ...]
 */
export function sosSteps(unitMs = UNIT_MS): TorchStep[] {
  const steps: TorchStep[] = []
  SOS_LETTERS.forEach((letter, li) => {
    letter.forEach((units, si) => {
      steps.push({ on: true, ms: units * unitMs })
      const last = si === letter.length - 1
      if (!last) steps.push({ on: false, ms: SYMBOL_GAP_UNITS * unitMs })
    })
    const lastLetter = li === SOS_LETTERS.length - 1
    steps.push({ on: false, ms: (lastLetter ? WORD_GAP_UNITS : LETTER_GAP_UNITS) * unitMs })
  })
  return steps
}

/**
 * 把频闪频率限制在安全范围内。
 *
 * @param hz 期望频率
 * @returns 落在 [MIN_STROBE_HZ, MAX_STROBE_HZ] 的频率；非数字取默认值
 * @example clampStrobeHz(30) // 3
 */
export function clampStrobeHz(hz: number): number {
  if (!Number.isFinite(hz)) return DEFAULT_STROBE_HZ
  return Math.min(MAX_STROBE_HZ, Math.max(MIN_STROBE_HZ, hz))
}

/**
 * 频闪时亮和灭各持续多久（占空比 50%）。
 *
 * @param hz 频率，会先被限制到安全范围
 * @returns 亮灭两步，各为半个周期
 * @example strobeSteps(2) // [{ on: true, ms: 250 }, { on: false, ms: 250 }]
 */
export function strobeSteps(hz: number): TorchStep[] {
  const half = Math.round(MS_PER_S / clampStrobeHz(hz) / 2)
  return [
    { on: true, ms: half },
    { on: false, ms: half },
  ]
}
