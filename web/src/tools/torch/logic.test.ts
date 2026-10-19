import { describe, expect, it } from 'vitest'
import { clampStrobeHz, DEFAULT_STROBE_HZ, MAX_STROBE_HZ, MIN_STROBE_HZ, sosSteps, strobeSteps, UNIT_MS } from './logic'

describe('sosSteps', () => {
  const steps = sosSteps()
  const onMs = steps.filter((s) => s.on).map((s) => s.ms)

  it('亮的序列是 短短短 长长长 短短短', () => {
    expect(onMs).toEqual([1, 1, 1, 3, 3, 3, 1, 1, 1].map((u) => u * UNIT_MS))
  })
  it('亮灭严格交替，首亮末灭', () => {
    expect(steps[0].on).toBe(true)
    expect(steps[steps.length - 1].on).toBe(false)
    steps.forEach((s, i) => expect(s.on).toBe(i % 2 === 0))
  })
  it('字母内间隔 1 单位、字母间 3 单位、轮末 7 单位', () => {
    const offMs = steps.filter((s) => !s.on).map((s) => s.ms / UNIT_MS)
    expect(offMs).toEqual([1, 1, 3, 1, 1, 3, 1, 1, 7])
  })
  it('单位时长可调', () => {
    expect(sosSteps(100)[0].ms).toBe(100)
  })
})

describe('strobe', () => {
  it('频率被限制在范围内', () => {
    expect(clampStrobeHz(30)).toBe(MAX_STROBE_HZ)
    expect(clampStrobeHz(0)).toBe(MIN_STROBE_HZ)
    expect(clampStrobeHz(-5)).toBe(MIN_STROBE_HZ)
    expect(clampStrobeHz(2)).toBe(2)
    expect(clampStrobeHz(NaN)).toBe(DEFAULT_STROBE_HZ)
  })
  it('占空比 50%，半周期为 500/Hz 毫秒', () => {
    expect(strobeSteps(2)).toEqual([
      { on: true, ms: 250 },
      { on: false, ms: 250 },
    ])
  })
  it('超限频率按上限出时序', () => {
    expect(strobeSteps(100)[0].ms).toBe(Math.round(500 / MAX_STROBE_HZ))
  })
})
