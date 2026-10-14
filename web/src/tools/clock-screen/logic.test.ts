import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SolarDay } from 'tyme4ts'
import { BURN_IN_RANGE, createAwake, burnInOffset, clockParts, formatDateLine, lunarText, msToNextSecond, startSecondTicker } from './logic'

describe('clockParts', () => {
  it('24 小时制补零', () => {
    expect(clockParts(new Date(2026, 0, 1, 5, 4, 3), true)).toEqual({ hh: '05', mm: '04', ss: '03', period: '' })
  })
  it('12 小时制：0 点与 12 点', () => {
    expect(clockParts(new Date(2026, 0, 1, 0, 0, 0), false)).toMatchObject({ hh: '12', period: '上午' })
    expect(clockParts(new Date(2026, 0, 1, 12, 30, 0), false)).toMatchObject({ hh: '12', period: '下午' })
    expect(clockParts(new Date(2026, 0, 1, 23, 59, 59), false)).toMatchObject({ hh: '11', mm: '59', period: '下午' })
  })
})

describe('formatDateLine / msToNextSecond', () => {
  it('日期与星期', () => {
    expect(formatDateLine(new Date(2026, 9, 13))).toBe('2026年10月13日 星期二')
  })
  it('距下一整秒', () => {
    expect(msToNextSecond(1500)).toBe(500)
    expect(msToNextSecond(2000)).toBe(1000)
    expect(msToNextSecond(2999)).toBe(1)
  })
})

describe('startSecondTicker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('立即回调一次，之后每秒一次，停止后不再触发', () => {
    vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 0, 400))
    const seen: number[] = []
    const stop = startSecondTicker((d) => seen.push(d.getSeconds()))
    expect(seen).toEqual([0])
    vi.advanceTimersByTime(700)
    expect(seen).toEqual([0, 1])
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([0, 1, 2])
    stop()
    vi.advanceTimersByTime(5000)
    expect(seen).toHaveLength(3)
  })
})

describe('burnInOffset', () => {
  it('偏移在范围内且随分钟变化', () => {
    const set = new Set<string>()
    for (let m = 0; m < 200; m++) {
      const o = burnInOffset(m)
      expect(Math.abs(o.x)).toBeLessThanOrEqual(BURN_IN_RANGE)
      expect(Math.abs(o.y)).toBeLessThanOrEqual(BURN_IN_RANGE)
      set.add(`${o.x},${o.y}`)
    }
    expect(set.size).toBeGreaterThan(10)
    expect(burnInOffset(-3)).toEqual(burnInOffset(3))
  })
})

describe('lunarText', () => {
  it('用真实 tyme4ts 取农历', () => {
    expect(lunarText({ SolarDay }, new Date(2026, 9, 13))).toBe('九月初四')
  })
  it('库抛错时返回空串', () => {
    const bad = {
      SolarDay: {
        fromYmd: () => {
          throw new Error('越界')
        },
      },
    }
    expect(lunarText(bad, new Date())).toBe('')
  })
})

describe('createAwake', () => {
  /** 造一个网页兜底桩 */
  const web = (ok = true) => ({ acquire: vi.fn(async () => ok), release: vi.fn(async () => undefined) })
  it('原生成功就不动网页，释放时关原生', async () => {
    const native = vi.fn(async () => undefined)
    const w = web()
    const a = createAwake({ native, web: w })
    expect(await a.acquire()).toBe(true)
    expect(w.acquire).not.toHaveBeenCalled()
    await a.release()
    expect(native).toHaveBeenNthCalledWith(1, true)
    expect(native).toHaveBeenNthCalledWith(2, false)
  })
  it('原生抛错回退网页，结果取网页的', async () => {
    const native = vi.fn(async () => Promise.reject(new Error('no host')))
    const w = web(false)
    const a = createAwake({ native, web: w })
    expect(await a.acquire()).toBe(false)
    await a.release()
    expect(native).toHaveBeenCalledTimes(1)
    expect(w.release).toHaveBeenCalled()
  })
  it('释放时原生抛错也不外泄', async () => {
    let n = 0
    const native = vi.fn(async () => {
      if (n++ > 0) throw new Error('x')
    })
    const a = createAwake({ native, web: web() })
    await a.acquire()
    await expect(a.release()).resolves.toBeUndefined()
  })
})
