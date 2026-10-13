// 做个决定：转盘逻辑。先抽出结果，再算转盘该转多少度，动画只是表演
import { randomInt, type RandomSource, cryptoSource } from '@/shared/random'

/** 转盘选项个数范围 */
export const MIN_SLICES = 2
export const MAX_SLICES = 12

/** 转盘至少多转几整圈 */
const MIN_TURNS = 4
/** 转盘最多额外多转几整圈 */
const EXTRA_TURNS = 2
/** 指针落点在扇区内的抖动范围占扇区宽度的比例（避免总停在正中，也不压线） */
const JITTER = 0.7
/** 抖动随机精度 */
const JITTER_STEPS = 1000

/** 转盘用的扇区配色（偏深，保证白字在每个扇区上都有足够对比度，相邻色差明显） */
export const SLICE_COLORS = [
  '#c8553d', '#b5651d', '#9a7d0a', '#1f7a6d', '#2f6fb5', '#5b4fcf',
  '#b83f95', '#4f7a38', '#8c5316', '#0f6b8a', '#a93226', '#117a65',
]

/** 一次转盘结果 */
export interface SpinResult {
  /** 中选扇区下标 */
  index: number
  /** 转盘最终旋转角度（度，顺时针，累加了整圈） */
  angle: number
}

/**
 * 转一次转盘。指针固定在 12 点方向，第 0 个扇区从 12 点顺时针开始。
 *
 * @param count 扇区数（2 ~ 12）
 * @param currentAngle 转盘当前累计角度，保证只往前转
 * @param src 随机源
 * @returns 中选下标与目标角度
 * @throws RangeError 扇区数越界
 * @example
 * spinWheel(4, 0) // { index: 2, angle: 1530 }
 */
export function spinWheel(count: number, currentAngle = 0, src: RandomSource = cryptoSource): SpinResult {
  if (!Number.isInteger(count) || count < MIN_SLICES || count > MAX_SLICES) {
    throw new RangeError('扇区数需在 2 ~ 12 之间')
  }
  const index = randomInt(0, count - 1, src)
  const slice = 360 / count
  const jitter = (randomInt(0, JITTER_STEPS, src) / JITTER_STEPS - 0.5) * JITTER * slice
  // 要让扇区中心（加抖动）转到 12 点：转盘需逆着扇区位置转回去
  const target = 360 - (index * slice + slice / 2 + jitter)
  const turns = MIN_TURNS + randomInt(0, EXTRA_TURNS, src)
  const base = Math.ceil(currentAngle / 360) * 360
  return { index, angle: base + turns * 360 + target }
}

/**
 * 根据转盘角度反推指针指向的扇区（用于校验与测试）。
 *
 * @param angle 转盘累计角度
 * @param count 扇区数
 * @returns 指针所指扇区下标
 * @example
 * indexAtAngle(0, 4) // 0
 */
export function indexAtAngle(angle: number, count: number): number {
  const slice = 360 / count
  const pointer = (((360 - (angle % 360)) % 360) + 360) % 360
  return Math.min(count - 1, Math.floor(pointer / slice))
}

/**
 * 生成转盘背景的 conic-gradient。
 *
 * @param count 扇区数
 * @returns CSS 背景值
 * @example
 * wheelGradient(2) // 'conic-gradient(#c8553d 0deg 180deg, #b5651d 180deg 360deg)'
 */
export function wheelGradient(count: number): string {
  const slice = 360 / count
  const stops = Array.from({ length: count }, (_, i) => {
    return `${SLICE_COLORS[i % SLICE_COLORS.length]} ${i * slice}deg ${(i + 1) * slice}deg`
  })
  return `conic-gradient(${stops.join(', ')})`
}
