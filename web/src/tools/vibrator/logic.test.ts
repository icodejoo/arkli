import { afterEach, describe, expect, it, vi } from 'vitest'
// logic 会加载原生封装，其模块初始化要读 window；node 环境先补一个空对象（无宿主）
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window = {}
})

import { applyIntensity, canVibrate, chunkPattern, createPlayer, formatPattern, MAX_SEGMENT_MS, MAX_SEGMENTS, MAX_TOTAL_MS, parsePattern, PRESETS, stopVibrate, totalDuration, vibratePattern } from './logic'

describe('parsePattern', () => {
  it('正常解析，支持多种分隔符', () => {
    expect(parsePattern('200,100,200')).toEqual({ pattern: [200, 100, 200], truncated: false, error: null })
    expect(parsePattern(' 200 ， 100；300、400 500 ').pattern).toEqual([200, 100, 300, 400, 500])
  })
  it('空输入报错', () => {
    expect(parsePattern('').error).toBeTruthy()
    expect(parsePattern(' , ').pattern).toEqual([])
  })
  it('非法字符、小数、负数、零报错', () => {
    expect(parsePattern('200,abc').error).toContain('abc')
    expect(parsePattern('1.5').error).toBeTruthy()
    expect(parsePattern('-5').error).toBeTruthy()
    expect(parsePattern('100,0').error).toBeTruthy()
    expect(parsePattern('100,0').pattern).toEqual([])
  })
  it('单段超长被压到上限', () => {
    const r = parsePattern('99999,100')
    expect(r.pattern).toEqual([MAX_SEGMENT_MS, 100])
    expect(r.truncated).toBe(true)
  })
  it('段数过多被截断', () => {
    const r = parsePattern(Array(MAX_SEGMENTS + 20).fill('10').join(','))
    expect(r.pattern.length).toBe(MAX_SEGMENTS)
    expect(r.truncated).toBe(true)
  })
  it('总时长不超过 30 秒，最后一段被裁短', () => {
    const r = parsePattern('5000,5000,5000,5000,5000,5000,5000,5000')
    expect(totalDuration(r.pattern)).toBe(MAX_TOTAL_MS)
    expect(r.pattern.length).toBe(6)
    expect(r.truncated).toBe(true)
  })
  it('恰好 30 秒不算截断', () => {
    const r = parsePattern('5000,5000,5000,5000,5000,5000')
    expect(totalDuration(r.pattern)).toBe(MAX_TOTAL_MS)
    expect(r.truncated).toBe(false)
  })
  it('裁到刚好用完时间时丢弃后面的段', () => {
    const r = parsePattern('5000,5000,5000,5000,5000,4000,1000,200')
    expect(totalDuration(r.pattern)).toBe(MAX_TOTAL_MS)
    expect(r.truncated).toBe(true)
  })
})

describe('totalDuration / formatPattern / PRESETS', () => {
  it('求和与格式化', () => {
    expect(totalDuration([200, 100, 200])).toBe(500)
    expect(totalDuration([])).toBe(0)
    expect(formatPattern([200, 100])).toBe('200,100')
  })
  it('预设合法：段数、时长在上限内，能被解析器原样接受', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(3)
    for (const p of PRESETS) {
      expect(totalDuration(p.pattern)).toBeLessThanOrEqual(MAX_TOTAL_MS)
      expect(parsePattern(formatPattern(p.pattern))).toEqual({ pattern: p.pattern, truncated: false, error: null })
    }
  })
  it('SOS 是 9 震 + 间隔', () => {
    const sos = PRESETS.find((p) => p.id === 'sos')!.pattern
    expect(sos.filter((_, i) => i % 2 === 0).length).toBe(9)
  })
  it('渐强的震动时长递增', () => {
    const r = PRESETS.find((p) => p.id === 'ramp')!.pattern.filter((_, i) => i % 2 === 0)
    expect([...r].sort((a, b) => a - b)).toEqual(r)
  })
})

describe('applyIntensity', () => {
  it('满强度原样返回（且是副本）', () => {
    const p = [100, 50]
    const r = applyIntensity(p, 1)
    expect(r).toEqual(p)
    expect(r).not.toBe(p)
  })
  it('半强度切成占空比', () => {
    expect(applyIntensity([80, 40], 0.5)).toEqual([20, 20, 20, 60])
  })
  it('总时长基本不变（只丢不足一个周期的尾巴），每段都为正', () => {
    for (const k of [0.2, 0.3, 0.5, 0.9, 0.99]) {
      const src = [333, 77, 150, 200, 41]
      const r = applyIntensity(src, k)
      expect(totalDuration(r)).toBeGreaterThanOrEqual(totalDuration(src) - 40)
      expect(totalDuration(r)).toBeLessThanOrEqual(totalDuration(src))
      expect(r.every((n) => n > 0)).toBe(true)
    }
  })
  it('极低强度被压到下限，非法值当满强度', () => {
    expect(applyIntensity([80], 0)).toEqual(applyIntensity([80], 0.2))
    expect(applyIntensity([80, 10], NaN)).toEqual([80, 10])
  })
  it('空序列返回空', () => {
    expect(applyIntensity([], 0.5)).toEqual([])
  })
})

describe('chunkPattern', () => {
  it('按偶数段切块', () => {
    expect(chunkPattern([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
  it('max 为奇数向下取偶，过小取 2', () => {
    expect(chunkPattern([1, 2, 3, 4, 5], 3)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunkPattern([1, 2, 3], 0)).toEqual([[1, 2], [3]])
  })
  it('空序列返回空数组；默认块不超过 98 段', () => {
    expect(chunkPattern([])).toEqual([])
    expect(chunkPattern(Array(250).fill(10)).every((c) => c.length <= 98)).toBe(true)
  })
})

describe('canVibrate / vibratePattern / stopVibrate', () => {
  it('没有 vibrate 时不支持，调用返回 false', () => {
    expect(canVibrate({})).toBe(false)
    expect(canVibrate(undefined)).toBe(false)
    expect(vibratePattern([100], {})).toBe(false)
  })
  it('支持时转发参数', () => {
    const fn = vi.fn(() => true)
    expect(canVibrate({ vibrate: fn })).toBe(true)
    expect(vibratePattern([100, 50], { vibrate: fn })).toBe(true)
    expect(fn).toHaveBeenCalledWith([100, 50])
  })
  it('返回 false 或抛错都当失败', () => {
    expect(vibratePattern(1, { vibrate: () => false })).toBe(false)
    expect(
      vibratePattern(1, {
        vibrate: () => {
          throw new Error('x')
        },
      }),
    ).toBe(false)
  })
  it('stopVibrate 传 0', () => {
    // 无注入时走全局 navigator，node 环境可能没有，只验证不抛错
    expect(() => stopVibrate({ vibrate: () => true })).not.toThrow()
    const fn = vi.fn(() => true)
    stopVibrate({ vibrate: fn })
    expect(fn).toHaveBeenCalledWith(0)
  })
})

describe('createPlayer', () => {
  afterEach(() => vi.useRealTimers())
  it('按块衔接，播完回调 onEnd', () => {
    vi.useFakeTimers()
    const calls: unknown[] = []
    const onEnd = vi.fn()
    const p = createPlayer({ vibrate: (x) => (calls.push(x), true), onEnd })
    p.start([[100, 50], [200]], false)
    expect(calls).toEqual([[100, 50]])
    vi.advanceTimersByTime(150)
    expect(calls).toEqual([[100, 50], [200]])
    expect(onEnd).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
  it('循环播放不会结束', () => {
    vi.useFakeTimers()
    const calls: unknown[] = []
    const onEnd = vi.fn()
    const p = createPlayer({ vibrate: (x) => (calls.push(x), true), onEnd })
    p.start([[100]], true)
    vi.advanceTimersByTime(350)
    expect(calls.length).toBe(4)
    expect(onEnd).not.toHaveBeenCalled()
    p.stop()
  })
  it('stop 取消震动、清定时器，且不触发 onEnd', () => {
    vi.useFakeTimers()
    const calls: unknown[] = []
    const onEnd = vi.fn()
    const p = createPlayer({ vibrate: (x) => (calls.push(x), true), onEnd })
    p.start([[100], [100]], false)
    p.stop()
    vi.advanceTimersByTime(1000)
    expect(calls).toEqual([[100], 0])
    expect(onEnd).not.toHaveBeenCalled()
  })
  it('空块立即结束；重复 start 会作废上一次', () => {
    vi.useFakeTimers()
    const calls: unknown[] = []
    const onEnd = vi.fn()
    const p = createPlayer({ vibrate: (x) => (calls.push(x), true), onEnd })
    p.start([], false)
    expect(onEnd).toHaveBeenCalledTimes(1)
    p.start([[100], [100]], false)
    p.start([[50]], false)
    vi.advanceTimersByTime(500)
    expect(calls).toEqual([[100], [50]])
    expect(onEnd).toHaveBeenCalledTimes(2)
  })
})

describe('默认走原生封装（无注入 nav）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('容器内：canVibrate 恒为 true，震动与取消转给 system', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { ArkliNative: { postMessage: vi.fn(), onmessage: null } })
    const vibrate = vi.fn(async () => true)
    const cancelVibrate = vi.fn(async () => undefined)
    vi.doMock('@/native/system', () => ({ vibrate, cancelVibrate }))
    const m = await import('./logic')
    expect(m.canVibrate()).toBe(true)
    expect(m.vibratePattern([100, 50, 100])).toBe(true)
    expect(vibrate).toHaveBeenLastCalledWith([0, 100, 50, 100])
    m.vibratePattern(80)
    expect(vibrate).toHaveBeenLastCalledWith(80)
    m.stopVibrate()
    m.vibratePattern([])
    expect(cancelVibrate).toHaveBeenCalledTimes(2)
    vi.doUnmock('@/native/system')
  })
  it('无宿主：canVibrate 看 navigator', async () => {
    vi.resetModules()
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', {})
    const m = await import('./logic')
    expect(m.canVibrate()).toBe(false)
    vi.stubGlobal('navigator', { vibrate: () => true })
    expect(m.canVibrate()).toBe(true)
  })
  it('原生调用失败不会抛出未处理的拒绝', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { ArkliNative: { postMessage: vi.fn(), onmessage: null } })
    vi.doMock('@/native/system', () => ({ vibrate: vi.fn(async () => Promise.reject(new Error('x'))), cancelVibrate: vi.fn() }))
    const m = await import('./logic')
    expect(m.vibratePattern([10])).toBe(true)
    await Promise.resolve()
    vi.doUnmock('@/native/system')
  })
})
