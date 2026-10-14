import { afterEach, describe, expect, it, vi } from 'vitest'
import { BEST_KEY, GRADES, gradeFor, isNewBest, isSuspicious, loadBest, randomWait, saveBest, summarize, WAIT_MAX_MS, WAIT_MIN_MS } from './logic'

/** 内存版 localStorage，可选让读写抛错 */
function fakeStorage(throws = false) {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => {
      if (throws) throw new Error('denied')
      return m.has(k) ? (m.get(k) as string) : null
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error('quota')
      m.set(k, v)
    },
  }
}

describe('randomWait', () => {
  it('落在 1.5~5 秒内，边界可达', () => {
    expect(randomWait(() => 0)).toBe(WAIT_MIN_MS)
    expect(randomWait(() => 0.999999)).toBeLessThan(WAIT_MAX_MS)
    expect(randomWait(() => 0.999999)).toBeGreaterThan(WAIT_MAX_MS - 10)
    for (let i = 0; i < 200; i++) {
      const v = randomWait()
      expect(v).toBeGreaterThanOrEqual(WAIT_MIN_MS)
      expect(v).toBeLessThan(WAIT_MAX_MS)
    }
  })
})

describe('gradeFor', () => {
  it('各档边界', () => {
    expect(gradeFor(0).title).toBe('神经闪电')
    expect(gradeFor(149).title).toBe('神经闪电')
    expect(gradeFor(150).title).toBe('电竞选手')
    expect(gradeFor(249).title).toBe('身手敏捷')
    expect(gradeFor(299).title).toBe('正常水平')
    expect(gradeFor(399).title).toBe('有点慢热')
    expect(gradeFor(400).title).toBe('还没睡醒')
    expect(gradeFor(99999).title).toBe('还没睡醒')
  })
  it('非法值当作最慢档', () => {
    expect(gradeFor(NaN)).toBe(GRADES[GRADES.length - 1])
    expect(gradeFor(-5)).toBe(GRADES[GRADES.length - 1])
  })
})

describe('summarize', () => {
  it('平均、最好、最差', () => {
    expect(summarize([200, 300, 250])).toEqual({ count: 3, average: 250, best: 200, worst: 300 })
    expect(summarize([201, 202])).toEqual({ count: 2, average: 202, best: 201, worst: 202 })
  })
  it('空数组与非法值', () => {
    expect(summarize([])).toEqual({ count: 0, average: 0, best: 0, worst: 0 })
    expect(summarize([NaN, -1, 100])).toEqual({ count: 1, average: 100, best: 100, worst: 100 })
  })
})

describe('isSuspicious', () => {
  it('低于 80ms 异常', () => {
    expect(isSuspicious(79)).toBe(true)
    expect(isSuspicious(80)).toBe(false)
  })
})

describe('isNewBest', () => {
  it('无历史、更快、更慢、非法', () => {
    expect(isNewBest(300, null)).toBe(true)
    expect(isNewBest(190, 200)).toBe(true)
    expect(isNewBest(200, 200)).toBe(false)
    expect(isNewBest(210, 200)).toBe(false)
    expect(isNewBest(NaN, null)).toBe(false)
    expect(isNewBest(0, null)).toBe(false)
  })
})

describe('loadBest / saveBest', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('存取往返并取整', () => {
    const st = fakeStorage()
    vi.stubGlobal('localStorage', st)
    expect(loadBest()).toBeNull()
    expect(saveBest(212.6)).toBe(true)
    expect(st.getItem(BEST_KEY)).toBe('213')
    expect(loadBest()).toBe(213)
  })
  it('脏数据返回 null', () => {
    const st = fakeStorage()
    vi.stubGlobal('localStorage', st)
    st.setItem(BEST_KEY, 'abc')
    expect(loadBest()).toBeNull()
    st.setItem(BEST_KEY, '-3')
    expect(loadBest()).toBeNull()
  })
  it('存储抛错或不存在时不崩', () => {
    vi.stubGlobal('localStorage', fakeStorage(true))
    expect(loadBest()).toBeNull()
    expect(saveBest(100)).toBe(false)
    vi.stubGlobal('localStorage', undefined)
    expect(loadBest()).toBeNull()
    expect(saveBest(100)).toBe(false)
  })
})
