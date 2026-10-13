import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { angleDiff, createCompassSession, createSmoother, directionName, headingFromEvent, normalizeDeg, startCompass, type CompassStatus, type EventSourceLike } from './logic'

/** 假事件源：记录监听并可手动派发 */
function fakeTarget() {
  const map = new Map<string, Set<(e: never) => void>>()
  const t: EventSourceLike & { emit(type: string, e: object): void; count(): number } = {
    addEventListener: (type, fn) => void (map.get(type) ?? map.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type, fn) => void map.get(type)?.delete(fn),
    emit: (type, e) => map.get(type)?.forEach((fn) => fn(e as never)),
    count: () => [...map.values()].reduce((n, s) => n + s.size, 0),
  }
  return t
}

describe('角度工具', () => {
  it('normalizeDeg 处理负数与超圈', () => {
    expect(normalizeDeg(-10)).toBe(350)
    expect(normalizeDeg(370)).toBe(10)
    expect(normalizeDeg(360)).toBe(0)
  })
  it('angleDiff 走最短弧', () => {
    expect(angleDiff(359, 1)).toBe(2)
    expect(angleDiff(1, 359)).toBe(-2)
    expect(angleDiff(0, 180)).toBe(180)
  })
  it('directionName 八方位与边界', () => {
    expect(directionName(0)).toBe('北')
    expect(directionName(359)).toBe('北')
    expect(directionName(22)).toBe('北')
    expect(directionName(23)).toBe('东北')
    expect(directionName(90)).toBe('东')
    expect(directionName(180)).toBe('南')
    expect(directionName(270)).toBe('西')
    expect(directionName(315)).toBe('西北')
    expect(directionName(-45)).toBe('西北')
  })
})

describe('headingFromEvent', () => {
  it('alpha 换算：逆时针转顺时针', () => {
    expect(headingFromEvent({ alpha: 90, absolute: true })).toBe(270)
    expect(headingFromEvent({ alpha: 0 })).toBe(0)
  })
  it('webkitCompassHeading 优先', () => {
    expect(headingFromEvent({ alpha: 90, webkitCompassHeading: 45 })).toBe(45)
  })
  it('补偿屏幕旋转并归一', () => {
    expect(headingFromEvent({ alpha: 10, absolute: true }, 90)).toBe(80)
    expect(headingFromEvent({ webkitCompassHeading: 300 }, 90)).toBe(30)
  })
  it('无数据为 null', () => {
    expect(headingFromEvent({ alpha: null })).toBeNull()
    expect(headingFromEvent({})).toBeNull()
    expect(headingFromEvent({ alpha: NaN })).toBeNull()
  })
})

describe('createSmoother', () => {
  it('首值原样，之后逐步靠近', () => {
    const s = createSmoother(0.5)
    expect(s.push(100)).toBe(100)
    expect(s.push(120)).toBe(110)
  })
  it('359 到 1 不绕大圈', () => {
    const s = createSmoother(0.5)
    s.push(359)
    const v = s.push(1)
    expect(v).toBeCloseTo(0, 5)
  })
  it('reset 后重新取首值；非法系数回退默认', () => {
    const s = createSmoother(5)
    s.push(10)
    s.reset()
    expect(s.push(200)).toBe(200)
  })
})

describe('startCompass', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('收到绝对事件进入 ok 并给出方位', () => {
    const t = fakeTarget()
    const st: CompassStatus[] = []
    const hs: number[] = []
    startCompass({ target: t, onHeading: (d) => hs.push(d), onStatus: (s) => st.push(s) })
    t.emit('deviceorientationabsolute', { alpha: 270, absolute: true })
    expect(st).toEqual(['waiting', 'ok'])
    expect(hs[0]).toBe(90)
  })
  it('只有相对事件（非 absolute）不算指南针数据', () => {
    const t = fakeTarget()
    const st: CompassStatus[] = []
    startCompass({ target: t, onHeading: () => {}, onStatus: (s) => st.push(s) })
    t.emit('deviceorientation', { alpha: 10, absolute: false })
    vi.advanceTimersByTime(3000)
    expect(st).toEqual(['waiting', 'unsupported'])
  })
  it('deviceorientation 带 absolute 或 webkitCompassHeading 可退回使用', () => {
    const t = fakeTarget()
    const hs: number[] = []
    startCompass({ target: t, onHeading: (d) => hs.push(d), onStatus: () => {} })
    t.emit('deviceorientation', { webkitCompassHeading: 120 })
    expect(hs).toEqual([120])
  })
  it('已有绝对事件后忽略相对事件', () => {
    const t = fakeTarget()
    const hs: number[] = []
    startCompass({ target: t, smooth: 1, onHeading: (d) => hs.push(d), onStatus: () => {} })
    t.emit('deviceorientationabsolute', { alpha: 0, absolute: true })
    t.emit('deviceorientation', { alpha: 90, absolute: true })
    expect(hs).toEqual([0])
  })
  it('null alpha 的事件（桌面浏览器）超时后判不支持', () => {
    const t = fakeTarget()
    const st: CompassStatus[] = []
    startCompass({ target: t, onHeading: () => {}, onStatus: (s) => st.push(s) })
    t.emit('deviceorientation', { alpha: null })
    vi.advanceTimersByTime(3000)
    expect(st[st.length - 1]).toBe('unsupported')
  })
  it('stop 会解绑全部监听且不再触发超时', () => {
    const t = fakeTarget()
    const st: CompassStatus[] = []
    const stop = startCompass({ target: t, onHeading: () => {}, onStatus: (s) => st.push(s) })
    expect(t.count()).toBe(2)
    stop()
    expect(t.count()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(st).toEqual(['waiting'])
  })
})

describe('createCompassSession', () => {
  it('begin 会先停掉上一次', () => {
    const stops: Array<ReturnType<typeof vi.fn>> = []
    const start = vi.fn(() => {
      const s = vi.fn()
      stops.push(s)
      return s
    })
    const session = createCompassSession(start)
    session.begin()
    session.begin()
    expect(start).toHaveBeenCalledTimes(2)
    expect(stops[0]).toHaveBeenCalledTimes(1)
    expect(stops[1]).not.toHaveBeenCalled()
  })
  it('dispose 后停止监听，之后的 begin（如授权回调）不再开始', async () => {
    const stop = vi.fn()
    const start = vi.fn(() => stop)
    const session = createCompassSession(start)
    session.begin()
    session.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    session.begin()
    expect(start).toHaveBeenCalledTimes(1)
  })
})
