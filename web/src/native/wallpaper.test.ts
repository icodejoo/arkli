import { afterEach, describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import { getWallpaper, wallpaperUrl } from './wallpaper'
import { NativeUnavailableError, type CallFn } from './system'

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as CallFn & typeof fn
}

afterEach(() => vi.unstubAllGlobals())

describe('wallpaper', () => {
  it('无宿主：抛 NativeUnavailableError', async () => {
    await expect(getWallpaper()).rejects.toBeInstanceOf(NativeUnavailableError)
  })
  it('成功与失败结果原样返回', async () => {
    vi.stubGlobal('window', { ArkliNative: { postMessage: vi.fn(), onmessage: null } })
    const ok = { available: true, path: 'cache/out/wallpaper/w.png', width: 1, height: 2, kind: 'current' }
    const call = fakeCall(ok)
    expect(await getWallpaper(call)).toEqual(ok)
    expect(call).toHaveBeenCalledWith('native.wallpaper.get', {}, expect.anything())
    const fail = { available: false, reason: 'restricted', message: 'x' }
    expect(await getWallpaper(fakeCall(fail))).toEqual(fail)
  })
  it('wallpaperUrl 拼同源路径', () => {
    expect(wallpaperUrl('cache/out/a.png')).toBe('/files/cache/out/a.png')
  })
})
