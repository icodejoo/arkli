import { afterEach, describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import { onNoiseSample, startNoise, stopNoise } from './noise'
import { NativeUnavailableError, type CallFn } from './system'

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as CallFn & typeof fn
}

/** 假宿主：让 isNativeAvailable 为真 */
function withHost() {
  vi.stubGlobal('window', { ArkliNative: { postMessage: vi.fn(), onmessage: null } })
}

afterEach(() => vi.unstubAllGlobals())

describe('noise', () => {
  it('无宿主：start / stop 抛 NativeUnavailableError', async () => {
    await expect(startNoise()).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(stopNoise()).rejects.toBeInstanceOf(NativeUnavailableError)
  })
  it('startNoise：间隔可省，返回采样率', async () => {
    withHost()
    const call = fakeCall({ started: true, sampleRate: 16000 })
    expect(await startNoise(undefined, call)).toEqual({ sampleRate: 16000 })
    expect(call).toHaveBeenCalledWith('native.noise.start', {}, { timeoutMs: 0 })
    await startNoise(200, call)
    expect(call).toHaveBeenLastCalledWith('native.noise.start', { intervalMs: 200 }, { timeoutMs: 0 })
  })
  it('stopNoise：调用 native.noise.stop', async () => {
    withHost()
    const call = fakeCall({ stopped: true })
    await stopNoise(call)
    expect(call).toHaveBeenCalledWith('native.noise.stop', {})
  })
  it('onNoiseSample：订阅 noise.sample 并可取消', () => {
    const off = vi.fn()
    let handler: ((d: unknown) => void) | null = null
    const on = vi.fn((_e: string, h: (d: unknown) => void) => {
      handler = h
      return off
    })
    const got: number[] = []
    const stop = onNoiseSample((s) => got.push(s.db), on)
    expect(on).toHaveBeenCalledWith('noise.sample', expect.any(Function))
    handler!({ db: 42, peakDb: 50, rmsDbfs: -48 })
    expect(got).toEqual([42])
    stop()
    expect(off).toHaveBeenCalled()
  })
})
