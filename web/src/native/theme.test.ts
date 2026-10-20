import { afterEach, describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import { setNativeTheme } from './theme'
import type { CallFn } from './system'

afterEach(() => vi.unstubAllGlobals())

describe('setNativeTheme', () => {
  it('无宿主时不调用也不抛错', async () => {
    const fn = vi.fn()
    await expect(setNativeTheme('dark', fn as unknown as CallFn)).resolves.toBeUndefined()
    expect(fn).not.toHaveBeenCalled()
  })
  it('有宿主时调 native.theme.set', async () => {
    vi.stubGlobal('window', { ArkliNative: { postMessage: vi.fn(), onmessage: null } })
    const fn = vi.fn(async () => ({ mode: 'dark' }))
    await setNativeTheme('dark', fn as unknown as CallFn)
    expect(fn).toHaveBeenCalledWith('native.theme.set', { mode: 'dark' })
  })
  it('原生调用失败时静默', async () => {
    vi.stubGlobal('window', { ArkliNative: { postMessage: vi.fn(), onmessage: null } })
    const fn = vi.fn(async () => {
      throw new Error('UNKNOWN_METHOD')
    })
    await expect(setNativeTheme('light', fn as unknown as CallFn)).resolves.toBeUndefined()
  })
})
