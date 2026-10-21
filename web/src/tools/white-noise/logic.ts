// 白噪音：各类噪声的合成纯函数（填充 Float32Array）与定时关闭计算，与 WebAudio 解耦

/** 随机函数：返回 [0,1) */
export type Rand = () => number

/** 噪声类型 */
export type NoiseKind = 'white' | 'pink' | 'brown' | 'rain' | 'ocean'

/** 噪声缓冲时长（秒），海浪的一个起伏周期恰好等于它，循环无缝 */
export const BUFFER_SECONDS = 8
/** 定时关闭可选分钟数 */
export const TIMER_OPTIONS: readonly number[] = [15, 30, 60]
/** 一分钟的毫秒数 */
export const MS_PER_MIN = 60000
/** 默认音量 [0,1] */
export const DEFAULT_VOLUME = 0.5

/** 噪声列表，供界面展示 */
export const NOISES: readonly { kind: NoiseKind; name: string; desc: string }[] = [
  { kind: 'white', name: '白噪声', desc: '均匀的沙沙声' },
  { kind: 'pink', name: '粉红噪声', desc: '更柔和，像远处的风' },
  { kind: 'brown', name: '棕色噪声', desc: '低沉浑厚，像瀑布' },
  { kind: 'rain', name: '雨声', desc: '细密的雨点' },
  { kind: 'ocean', name: '海浪', desc: '缓慢起伏的浪涌' },
]

/** 钳到 [-1,1] */
function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v))
}

/**
 * 白噪声：每个采样独立均匀分布。
 *
 * @param buf 待填充缓冲
 * @param rand 随机函数
 * @returns 同一个 buf
 * @example fillWhite(new Float32Array(1024), Math.random)
 */
export function fillWhite(buf: Float32Array, rand: Rand = Math.random): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] = rand() * 2 - 1
  return buf
}

/**
 * 粉红噪声（Paul Kellet 近似），能量随频率升高下降。
 *
 * @param buf 待填充缓冲
 * @param rand 随机函数
 * @returns 同一个 buf
 * @example fillPink(new Float32Array(1024))
 */
export function fillPink(buf: Float32Array, rand: Rand = Math.random): Float32Array {
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 0
  let b4 = 0
  let b5 = 0
  let b6 = 0
  for (let i = 0; i < buf.length; i++) {
    const w = rand() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    buf[i] = clamp1((b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11)
    b6 = w * 0.115926
  }
  return buf
}

/**
 * 棕色噪声（积分白噪声，带泄漏防漂移），低频更重。
 *
 * @param buf 待填充缓冲
 * @param rand 随机函数
 * @returns 同一个 buf
 * @example fillBrown(new Float32Array(1024))
 */
export function fillBrown(buf: Float32Array, rand: Rand = Math.random): Float32Array {
  let last = 0
  for (let i = 0; i < buf.length; i++) {
    const w = rand() * 2 - 1
    last = (last + 0.02 * w) / 1.02
    buf[i] = clamp1(last * 3.5)
  }
  return buf
}

/**
 * 雨声：高通白噪声做底，叠加随机的指数衰减雨点。
 *
 * @param buf 待填充缓冲
 * @param rand 随机函数
 * @returns 同一个 buf
 * @example fillRain(new Float32Array(44100))
 */
export function fillRain(buf: Float32Array, rand: Rand = Math.random): Float32Array {
  let prev = 0
  let drop = 0
  for (let i = 0; i < buf.length; i++) {
    const w = rand() * 2 - 1
    // 一阶差分近似高通，去掉低频轰鸣
    const hp = w - prev
    prev = w
    if (rand() < 0.0008) drop = 0.5 + rand() * 0.5
    drop *= 0.992
    buf[i] = clamp1(hp * 0.25 + (rand() * 2 - 1) * drop * 0.6)
  }
  return buf
}

/**
 * 海浪：棕色噪声乘以慢速起伏包络，一个周期铺满整个缓冲。
 *
 * @param buf 待填充缓冲
 * @param rand 随机函数
 * @returns 同一个 buf
 * @example fillOcean(new Float32Array(44100 * 8))
 */
export function fillOcean(buf: Float32Array, rand: Rand = Math.random): Float32Array {
  fillBrown(buf, rand)
  const n = buf.length
  for (let i = 0; i < n; i++) {
    const env = 0.2 + 0.8 * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n))
    buf[i] = clamp1(buf[i] * env * 1.4)
  }
  return buf
}

/**
 * 按类型填充噪声。
 *
 * @param kind 噪声类型
 * @param buf 待填充缓冲
 * @param rand 随机函数
 * @returns 同一个 buf
 * @example fillNoise('rain', new Float32Array(44100))
 */
export function fillNoise(kind: NoiseKind, buf: Float32Array, rand: Rand = Math.random): Float32Array {
  switch (kind) {
    case 'white':
      return fillWhite(buf, rand)
    case 'pink':
      return fillPink(buf, rand)
    case 'brown':
      return fillBrown(buf, rand)
    case 'rain':
      return fillRain(buf, rand)
    default:
      return fillOcean(buf, rand)
  }
}

/**
 * 距离定时关闭还剩多少毫秒。
 *
 * @param endAt 关闭时刻（毫秒时间戳）；null 表示没定时
 * @param now 当前时刻
 * @returns 剩余毫秒（不为负）；没定时返回 null
 * @example remainingMs(1000, 400) // 600
 */
export function remainingMs(endAt: number | null, now: number): number | null {
  return endAt === null ? null : Math.max(0, endAt - now)
}

/**
 * 浮起恢复后重算关闭时刻：把冻结的剩余毫秒接到当前时刻上，浮起期间的时间不计入。
 *
 * @param remain 浮起时冻结的剩余毫秒
 * @param now 恢复时的当前时刻
 * @returns 新的关闭时刻（毫秒时间戳）
 * @example resumeEndAt(600, 5000) // 5600
 */
export function resumeEndAt(remain: number, now: number): number {
  return now + Math.max(0, remain)
}

/**
 * 剩余时间格式化为 mm:ss。
 *
 * @param ms 毫秒数
 * @returns 如 "14:59"（向上取整到秒）
 * @example formatRemaining(61000) // '01:01'
 */
export function formatRemaining(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 音量钳到 [0,1]，非数字回落默认值。
 *
 * @param v 输入音量
 * @returns 合法音量
 * @example clampVolume(1.5) // 1
 */
export function clampVolume(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : DEFAULT_VOLUME
}
