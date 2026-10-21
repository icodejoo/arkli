import { afterEach, describe, expect, it, vi } from 'vitest'
import { countSides, createSettleTimer, envelopePoints, flipCoin, flipCoins, loadFlag, MAX_FLIPS, MIN_GAIN, saveFlag, toneSpecs, VIBRATE_LAND, VIBRATE_START } from './logic'

describe('flipCoin', () => {
  it('随机源偶数为正面、奇数为反面', () => {
    expect(flipCoin(() => 0)).toBe('heads')
    expect(flipCoin(() => 1)).toBe('tails')
  })
})

describe('flipCoins', () => {
  it('返回指定次数', () => {
    expect(flipCoins(5)).toHaveLength(5)
    expect(flipCoins(3, () => 1)).toEqual(['tails', 'tails', 'tails'])
  })
  it('次数非法抛错', () => {
    expect(() => flipCoins(0)).toThrow(RangeError)
    expect(() => flipCoins(MAX_FLIPS + 1)).toThrow(RangeError)
    expect(() => flipCoins(1.5)).toThrow(RangeError)
  })
  it('大样本接近五五开', () => {
    const c = countSides(Array.from({ length: 20000 }, () => flipCoin()))
    expect(Math.abs(c.heads - 10000)).toBeLessThan(500)
  })
})

describe('countSides', () => {
  it('统计个数，空列表为 0', () => {
    expect(countSides(['heads', 'tails', 'heads'])).toEqual({ heads: 2, tails: 1 })
    expect(countSides([])).toEqual({ heads: 0, tails: 0 })
  })
})

describe('反馈：合成参数', () => {
  it('抛出是短促的单音，落定是更长的双音', () => {
    const s = toneSpecs('start')
    const l = toneSpecs('land')
    expect(s).toHaveLength(1)
    expect(l).toHaveLength(2)
    expect(s[0].durMs).toBeLessThan(l[0].durMs)
    expect(l[1].freq).toBe(l[0].freq * 2)
  })
  it('返回的是副本，改了不影响下次', () => {
    toneSpecs('start')[0].freq = 1
    expect(toneSpecs('start')[0].freq).toBe(1800)
  })
  it('包络：先升后指数衰减，终点在时长处', () => {
    const p = envelopePoints({ startMs: 0, freq: 1000, durMs: 100, peak: 0.2, attackMs: 5, type: 'sine' })
    expect(p).toEqual([
      { t: 0, v: MIN_GAIN, ramp: 'linear' },
      { t: 0.005, v: 0.2, ramp: 'linear' },
      { t: 0.1, v: MIN_GAIN, ramp: 'exp' },
    ])
  })
  it('包络：起音不超过时长一半，峰值夹在 [MIN_GAIN, 1]', () => {
    const p = envelopePoints({ startMs: 0, freq: 1000, durMs: 10, peak: 5, attackMs: 100, type: 'sine' })
    expect(p[1].t).toBeCloseTo(0.005)
    expect(p[1].v).toBe(1)
    expect(envelopePoints({ startMs: 0, freq: 1, durMs: 10, peak: 0, attackMs: 1, type: 'sine' })[1].v).toBe(MIN_GAIN)
  })
  it('震动节奏符合 [停, 震, ...] 约定', () => {
    expect(VIBRATE_START).toEqual([0, 30])
    expect(VIBRATE_LAND).toEqual([0, 20, 40, 20])
  })
})

describe('开关存取', () => {
  /** 内存存储 */
  const mem = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }
  it('没存过用默认值，存过读回', () => {
    const s = mem()
    expect(loadFlag(s, 'k', true)).toBe(true)
    expect(loadFlag(s, 'k', false)).toBe(false)
    saveFlag(s, 'k', false)
    expect(loadFlag(s, 'k', true)).toBe(false)
    saveFlag(s, 'k', true)
    expect(loadFlag(s, 'k', false)).toBe(true)
  })
  it('存储缺失或抛错时静默回退', () => {
    const bad = {
      getItem: () => {
        throw new Error('x')
      },
      setItem: () => {
        throw new Error('x')
      },
    }
    expect(loadFlag(undefined, 'k', true)).toBe(true)
    expect(loadFlag(bad, 'k', false)).toBe(false)
    expect(() => saveFlag(bad, 'k', true)).not.toThrow()
    expect(() => saveFlag(undefined, 'k', true)).not.toThrow()
  })
})

describe('createSettleTimer', () => {
  afterEach(() => vi.useRealTimers())

  it('到点自然结算：finish(false) 只调一次，tick 在期间触发', () => {
    vi.useFakeTimers()
    const t = createSettleTimer()
    const done: boolean[] = []
    let ticks = 0
    t.start((early) => done.push(early), 600, { fn: () => ticks++, ms: 100 })
    expect(t.pending).toBe(true)
    vi.advanceTimersByTime(650)
    expect(done).toEqual([false])
    expect(ticks).toBe(5)
    expect(t.pending).toBe(false)
  })
  it('settleNow：提前结算为 finish(true)，之后到点不再重复结算，tick 也停了', () => {
    vi.useFakeTimers()
    const t = createSettleTimer()
    const done: boolean[] = []
    let ticks = 0
    t.start((early) => done.push(early), 600, { fn: () => ticks++, ms: 100 })
    vi.advanceTimersByTime(250)
    expect(t.settleNow()).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(done).toEqual([true])
    expect(ticks).toBe(2)
  })
  it('没有进行中的动画时 settleNow 返回 false 且无副作用（普通路由切换也会触发 pause）', () => {
    const t = createSettleTimer()
    expect(t.settleNow()).toBe(false)
  })
  it('结算后可再次 start（结算后下一次能正常跑）', () => {
    vi.useFakeTimers()
    const t = createSettleTimer()
    const done: boolean[] = []
    t.start((e) => done.push(e), 100)
    t.settleNow()
    t.start((e) => done.push(e), 100)
    vi.advanceTimersByTime(120)
    expect(done).toEqual([true, false])
  })
  it('clear 只清不结算', () => {
    vi.useFakeTimers()
    const t = createSettleTimer()
    const done: boolean[] = []
    t.start((e) => done.push(e), 100)
    t.clear()
    vi.advanceTimersByTime(500)
    expect(done).toEqual([])
    expect(t.pending).toBe(false)
  })
})
