import { describe, expect, it } from 'vitest'
import { clampVolume, DEFAULT_VOLUME, fillBrown, fillNoise, fillOcean, fillPink, fillRain, fillWhite, formatRemaining, remainingMs, resumeEndAt, type NoiseKind } from './logic'

/** 可复现的伪随机（mulberry32） */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 一阶自相关系数：越接近 1 越偏低频 */
function lag1(b: Float32Array): number {
  let num = 0
  let den = 0
  for (let i = 1; i < b.length; i++) {
    num += b[i] * b[i - 1]
    den += b[i] * b[i]
  }
  return num / den
}

/** 均方根 */
function rms(b: Float32Array): number {
  let s = 0
  for (const v of b) s += v * v
  return Math.sqrt(s / b.length)
}

const N = 20000

describe('噪声合成', () => {
  it('所有类型输出都在 [-1,1] 且非全零', () => {
    for (const k of ['white', 'pink', 'brown', 'rain', 'ocean'] as NoiseKind[]) {
      const b = fillNoise(k, new Float32Array(N), seeded(1))
      expect(Math.max(...b)).toBeLessThanOrEqual(1)
      expect(Math.min(...b)).toBeGreaterThanOrEqual(-1)
      expect(rms(b)).toBeGreaterThan(0.01)
    }
  })
  it('返回同一个缓冲', () => {
    const b = new Float32Array(8)
    expect(fillWhite(b, seeded(1))).toBe(b)
  })
  it('白噪声均值接近 0、相邻采样几乎无关', () => {
    const b = fillWhite(new Float32Array(N), seeded(2))
    expect(Math.abs(b.reduce((a, v) => a + v, 0) / N)).toBeLessThan(0.02)
    expect(Math.abs(lag1(b))).toBeLessThan(0.05)
  })
  it('低频成分：白 < 粉红 < 棕色', () => {
    const w = lag1(fillWhite(new Float32Array(N), seeded(3)))
    const p = lag1(fillPink(new Float32Array(N), seeded(3)))
    const br = lag1(fillBrown(new Float32Array(N), seeded(3)))
    expect(p).toBeGreaterThan(w + 0.2)
    expect(br).toBeGreaterThan(p)
    expect(br).toBeGreaterThan(0.9)
  })
  it('雨声偏高频（自相关为负或很低）', () => {
    expect(lag1(fillRain(new Float32Array(N), seeded(4)))).toBeLessThan(0.2)
  })
  it('海浪音量随周期起伏：中段比首尾响', () => {
    const b = fillOcean(new Float32Array(N * 4), seeded(5))
    const q = b.length / 8
    const edge = rms(b.slice(0, q))
    const mid = rms(b.slice(b.length / 2 - q / 2, b.length / 2 + q / 2))
    expect(mid).toBeGreaterThan(edge * 2)
  })
  it('相同种子结果一致', () => {
    const a = fillPink(new Float32Array(100), seeded(9))
    const b = fillPink(new Float32Array(100), seeded(9))
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})

describe('定时与音量', () => {
  it('remainingMs', () => {
    expect(remainingMs(null, 5)).toBeNull()
    expect(remainingMs(1000, 400)).toBe(600)
    expect(remainingMs(1000, 2000)).toBe(0)
  })
  it('formatRemaining 向上取整', () => {
    expect(formatRemaining(61000)).toBe('01:01')
    expect(formatRemaining(59001)).toBe('01:00')
    expect(formatRemaining(0)).toBe('00:00')
    expect(formatRemaining(-5)).toBe('00:00')
  })
  it('clampVolume', () => {
    expect(clampVolume(1.5)).toBe(1)
    expect(clampVolume(-1)).toBe(0)
    expect(clampVolume(0.3)).toBe(0.3)
    expect(clampVolume(NaN)).toBe(DEFAULT_VOLUME)
  })
})

describe('浮窗暂停 / 恢复的定时重算', () => {
  it('resumeEndAt：冻结的剩余接到恢复时刻上，浮起期间的时间不计入', () => {
    const endAt = 100_000
    const pausedAt = 40_000
    const remain = remainingMs(endAt, pausedAt) as number
    expect(remain).toBe(60_000)
    // 浮起 5 秒后在 45_000 回来，剩余仍是 60 秒
    const resumed = resumeEndAt(remain, 45_000)
    expect(remainingMs(resumed, 45_000)).toBe(60_000)
  })
  it('resumeEndAt：负数按 0 处理，恢复即到点', () => {
    expect(resumeEndAt(-5, 1000)).toBe(1000)
  })
})
