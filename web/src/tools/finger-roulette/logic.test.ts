import { describe, expect, it } from 'vitest'
import { assignRoles, canCountdown, colorFor, COUNTDOWN_MS, countdownProgress, FINGER_COLORS, hasMoved, MOVE_TOLERANCE_PX } from './logic'

/** 按固定序列返回 uint32 的随机源 */
function seq(...vals: number[]) {
  let i = 0
  return () => vals[i++ % vals.length]
}

describe('hasMoved', () => {
  it('超过容差才算动', () => {
    expect(hasMoved({ x: 0, y: 0 }, { x: MOVE_TOLERANCE_PX, y: 0 })).toBe(false)
    expect(hasMoved({ x: 0, y: 0 }, { x: MOVE_TOLERANCE_PX + 1, y: 0 })).toBe(true)
    expect(hasMoved({ x: 0, y: 0 }, { x: 9, y: 9 })).toBe(true)
    expect(hasMoved({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(false)
  })
  it('可自定义容差', () => {
    expect(hasMoved({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toBe(false)
    expect(hasMoved({ x: 0, y: 0 }, { x: 3, y: 4 }, 4)).toBe(true)
  })
})

describe('canCountdown', () => {
  it('至少两指', () => {
    expect(canCountdown(0)).toBe(false)
    expect(canCountdown(1)).toBe(false)
    expect(canCountdown(2)).toBe(true)
    expect(canCountdown(5)).toBe(true)
  })
})

describe('countdownProgress', () => {
  it('线性并截断', () => {
    expect(countdownProgress(0)).toBe(0)
    expect(countdownProgress(COUNTDOWN_MS / 2)).toBe(0.5)
    expect(countdownProgress(COUNTDOWN_MS)).toBe(1)
    expect(countdownProgress(COUNTDOWN_MS * 3)).toBe(1)
    expect(countdownProgress(-10)).toBe(0)
    expect(countdownProgress(NaN)).toBe(0)
  })
})

describe('assignRoles', () => {
  it('手指数不足抛错', () => {
    expect(() => assignRoles([1], 'one')).toThrow(RangeError)
    expect(() => assignRoles([], 'teams')).toThrow(RangeError)
  })
  it('选一个：恰好一个 winner，顺序与输入一致', () => {
    const r = assignRoles([7, 8, 9], 'one', seq(1))
    expect(r.map((x) => x.id)).toEqual([7, 8, 9])
    expect(r.filter((x) => x.role === 'winner').length).toBe(1)
    expect(r.filter((x) => x.role === 'loser').length).toBe(2)
    expect(r[1].role).toBe('winner')
  })
  it('选先手：顺位是 1..N 的排列，第 1 位是 winner', () => {
    const ids = [3, 4, 5, 6]
    const r = assignRoles(ids, 'first')
    expect(r.map((x) => x.order).sort()).toEqual([1, 2, 3, 4])
    const first = r.filter((x) => x.order === 1)
    expect(first.length).toBe(1)
    expect(first[0].role).toBe('winner')
    expect(r.filter((x) => x.role === 'ranked').length).toBe(3)
  })
  it('分两队：人数相差不超过 1，奇数时 A 队多一人', () => {
    for (const n of [2, 3, 4, 5, 7]) {
      const ids = Array.from({ length: n }, (_, i) => i + 1)
      const r = assignRoles(ids, 'teams')
      const a = r.filter((x) => x.role === 'teamA').length
      const b = r.filter((x) => x.role === 'teamB').length
      expect(a + b).toBe(n)
      expect(a - b).toBe(n % 2)
    }
  })
  it('随机性：每个手指都有机会被选中', () => {
    const hit = new Set<number>()
    for (let i = 0; i < 200; i++) hit.add(assignRoles([1, 2, 3], 'one').find((x) => x.role === 'winner')!.id)
    expect(hit.size).toBe(3)
  })
})

describe('colorFor', () => {
  it('循环取色，负数也安全', () => {
    expect(colorFor(0)).toBe(FINGER_COLORS[0])
    expect(colorFor(FINGER_COLORS.length)).toBe(FINGER_COLORS[0])
    expect(colorFor(-1)).toBe(FINGER_COLORS[FINGER_COLORS.length - 1])
  })
})
