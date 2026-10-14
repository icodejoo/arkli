import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyZero, bubbleOffset, foldToQuarter, formatDeg, GRAVITY, inPlaneAngle, isSteady, isValidVec, lowPass, startGravity, tiltFromGravity, totalTilt } from './logic'

/** 重力常量简写 */
const G = GRAVITY

describe('tiltFromGravity', () => {
  it('平放为 0/0', () => {
    const t = tiltFromGravity({ x: 0, y: 0, z: G })
    expect(t.pitch).toBeCloseTo(0)
    expect(t.roll).toBeCloseTo(0)
  })
  it('竖放（顶边朝上）俯仰 90', () => {
    expect(tiltFromGravity({ x: 0, y: G, z: 0 }).pitch).toBeCloseTo(90)
  })
  it('右边抬起 30 度横滚为正', () => {
    const a = (30 * Math.PI) / 180
    const t = tiltFromGravity({ x: G * Math.sin(a), y: 0, z: G * Math.cos(a) })
    expect(t.roll).toBeCloseTo(30)
    expect(t.pitch).toBeCloseTo(0)
  })
  it('顶边抬起 45 度俯仰为正', () => {
    const a = Math.PI / 4
    expect(tiltFromGravity({ x: 0, y: G * Math.sin(a), z: G * Math.cos(a) }).pitch).toBeCloseTo(45)
  })
  it('invert 符号相反', () => {
    const a = tiltFromGravity({ x: 2, y: 3, z: 9 })
    const b = tiltFromGravity({ x: -2, y: -3, z: -9 }, true)
    expect(b.pitch).toBeCloseTo(a.pitch)
    expect(b.roll).toBeCloseTo(a.roll)
    expect(tiltFromGravity({ x: 2, y: 3, z: 9 }, true).roll).toBeCloseTo(-a.roll)
  })
  it('零向量返回 0', () => {
    expect(tiltFromGravity({ x: 0, y: 0, z: 0 })).toEqual({ pitch: 0, roll: 0 })
  })
})

describe('totalTilt', () => {
  it('平放 0，正反面都一样', () => {
    expect(totalTilt({ x: 0, y: 0, z: G })).toBeCloseTo(0)
    expect(totalTilt({ x: 0, y: 0, z: -G })).toBeCloseTo(0)
  })
  it('竖直 90', () => {
    expect(totalTilt({ x: 0, y: G, z: 0 })).toBeCloseTo(90)
  })
  it('零向量为 0', () => {
    expect(totalTilt({ x: 0, y: 0, z: 0 })).toBe(0)
  })
})

describe('inPlaneAngle 与 foldToQuarter', () => {
  it('竖直握持为 0，横着为 90', () => {
    expect(inPlaneAngle({ x: 0, y: G, z: 0 })).toBeCloseTo(0)
    expect(inPlaneAngle({ x: G, y: 0, z: 0 })).toBeCloseTo(90)
  })
  it('折算到 [-45,45]', () => {
    expect(foldToQuarter(93)).toBeCloseTo(3)
    expect(foldToQuarter(-93)).toBeCloseTo(-3)
    expect(foldToQuarter(180)).toBeCloseTo(0)
    expect(foldToQuarter(-10)).toBeCloseTo(-10)
    expect(foldToQuarter(45)).toBeCloseTo(45)
  })
})

describe('lowPass', () => {
  it('首帧直接返回', () => {
    expect(lowPass(null, { x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 })
  })
  it('按 alpha 插值', () => {
    expect(lowPass({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0.5)).toEqual({ x: 5, y: 0, z: 0 })
  })
  it('非法 alpha 回退默认', () => {
    expect(lowPass({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0).x).toBeCloseTo(1.5)
    expect(lowPass({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 2).x).toBeCloseTo(1.5)
  })
})

describe('isSteady / isValidVec', () => {
  it('静止可信，猛晃不可信', () => {
    expect(isSteady({ x: 0, y: 0, z: G })).toBe(true)
    expect(isSteady({ x: 20, y: 0, z: 20 })).toBe(false)
    expect(isSteady({ x: 0, y: 0, z: 0 })).toBe(false)
  })
  it('识别缺失和 NaN', () => {
    expect(isValidVec({ x: 1, y: 2, z: 3 })).toBe(true)
    expect(isValidVec({ x: 1, y: null, z: 3 })).toBe(false)
    expect(isValidVec({ x: NaN, y: 1, z: 1 })).toBe(false)
    expect(isValidVec(null)).toBe(false)
    expect(isValidVec(undefined)).toBe(false)
  })
})

describe('applyZero / bubbleOffset / formatDeg', () => {
  it('校准扣掉零点', () => {
    expect(applyZero({ pitch: 5, roll: 2 }, { pitch: 3, roll: 1 })).toEqual({ pitch: 2, roll: 1 })
    expect(applyZero({ pitch: 5, roll: 2 }, null)).toEqual({ pitch: 5, roll: 2 })
  })
  it('气泡位置归一并截断', () => {
    expect(bubbleOffset(7.5, 15)).toBeCloseTo(0.5)
    expect(bubbleOffset(99)).toBe(1)
    expect(bubbleOffset(-99)).toBe(-1)
    expect(bubbleOffset(15, 0)).toBe(1)
  })
  it('读数格式化不出现 -0.0', () => {
    expect(formatDeg(-0.04)).toBe('0.0°')
    expect(formatDeg(3.16)).toBe('3.2°')
    expect(formatDeg(-12)).toBe('-12.0°')
  })
})

describe('startGravity', () => {
  afterEach(() => vi.useRealTimers())
  /** 假事件源 */
  function fake() {
    let fn: ((e: never) => void) | null = null
    return {
      addEventListener: (_t: string, f: (e: never) => void) => void (fn = f),
      removeEventListener: () => void (fn = null),
      emit: (e: object) => fn?.(e as never),
      has: () => fn !== null,
    }
  }
  it('收到读数后变 ok 并回调，首帧不滤波', () => {
    const t = fake()
    const vs: unknown[] = []
    const ss: string[] = []
    startGravity({ target: t, onVector: (v) => vs.push(v), onStatus: (s) => ss.push(s) })
    t.emit({ accelerationIncludingGravity: { x: 1, y: 2, z: 3 } })
    t.emit({ accelerationIncludingGravity: { x: null, y: 2, z: 3 } })
    expect(ss).toEqual(['waiting', 'ok'])
    expect(vs).toEqual([{ x: 1, y: 2, z: 3 }])
  })
  it('超时无数据报 unsupported', () => {
    vi.useFakeTimers()
    const t = fake()
    const ss: string[] = []
    startGravity({ target: t, onVector: () => {}, onStatus: (s) => ss.push(s), timeoutMs: 100 })
    vi.advanceTimersByTime(101)
    expect(ss).toEqual(['waiting', 'unsupported'])
  })
  it('停止后清监听且不再报超时', () => {
    vi.useFakeTimers()
    const t = fake()
    const ss: string[] = []
    const stop = startGravity({ target: t, onVector: () => {}, onStatus: (s) => ss.push(s), timeoutMs: 100 })
    stop()
    vi.advanceTimersByTime(200)
    expect(t.has()).toBe(false)
    expect(ss).toEqual(['waiting'])
  })
})
