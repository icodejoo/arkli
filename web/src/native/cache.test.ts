import { afterEach, describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import { clearCache, clearText, getCacheStats, statsText } from './cache'
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

describe('cache 封装', () => {
  it('无宿主抛 NativeUnavailableError', async () => {
    await expect(getCacheStats()).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(clearCache()).rejects.toBeInstanceOf(NativeUnavailableError)
  })
  it('getCacheStats / clearCache 调对应方法', async () => {
    withHost()
    const stats = { bytes: 10, files: 1, byDir: {} }
    const c1 = fakeCall(stats)
    expect(await getCacheStats(c1)).toEqual(stats)
    expect(c1).toHaveBeenCalledWith('native.cache.stats', {})
    const res = { freedBytes: 5, deleted: 1, skipped: 0 }
    const c2 = fakeCall(res)
    expect(await clearCache(c2)).toEqual(res)
    expect(c2).toHaveBeenCalledWith('native.cache.clear', {})
  })
  it('文案', () => {
    expect(statsText({ bytes: 1536, files: 2, byDir: {} })).toBe('缓存占用 1.5 KB（2 个文件）')
    expect(clearText({ freedBytes: 2 * 1024 * 1024, deleted: 3, skipped: 1 })).toBe('已释放 2.00 MB（删除 3 个文件）')
  })
})
