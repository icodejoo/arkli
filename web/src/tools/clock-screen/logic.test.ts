import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SolarDay } from 'tyme4ts'
import { BURN_IN_RANGE, burnInOffset, clockParts, formatDateLine, lunarText, msToNextSecond, startSecondTicker } from './logic'
import { createWakeLock, type VisibilityDoc, type WakeNavigator } from '@/shared/wakelock'

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

describe('createWakeLock', () => {
  /** 假文档，可手动触发可见性事件 */
  function fakeDoc() {
    let fn: (() => void) | undefined
    const d: VisibilityDoc & { show(): void } = {
      visibilityState: 'visible',
      addEventListener: (_t, f) => void (fn = f),
      removeEventListener: () => void (fn = undefined),
      show: () => fn?.(),
    }
    return d
  }
  it('不支持时返回 false 不报错', async () => {
    const wl = createWakeLock({}, fakeDoc())
    expect(wl.supported).toBe(false)
    expect(await wl.acquire()).toBe(false)
    await wl.release()
  })
  it('申请被拒绝返回 false', async () => {
    const nav: WakeNavigator = { wakeLock: { request: () => Promise.reject(new Error('NotAllowed')) } }
    expect(await createWakeLock(nav, fakeDoc()).acquire()).toBe(false)
  })
  it('成功申请，释放后调用 release；回到前台自动重申请', async () => {
    const release = vi.fn(() => Promise.resolve())
    const request = vi.fn(() => Promise.resolve({ release }))
    const doc = fakeDoc()
    const wl = createWakeLock({ wakeLock: { request } }, doc)
    expect(await wl.acquire()).toBe(true)
    doc.show()
    expect(request).toHaveBeenCalledTimes(2)
    await wl.release()
    expect(release).toHaveBeenCalledTimes(1)
    doc.show()
    expect(request).toHaveBeenCalledTimes(2)
  })
})
