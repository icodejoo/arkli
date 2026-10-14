import { afterEach, describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import { deleteDirItems, forgetDir, listDirs, pickDir, scanDir } from './dir'
import { NativeUnavailableError, type CallFn } from './system'
import type { OnFn } from './tts'

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

describe('无宿主', () => {
  it('全部抛 NativeUnavailableError', async () => {
    await expect(pickDir()).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(listDirs()).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(forgetDir('t')).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(scanDir('t', { mode: 'all' })).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(deleteDirItems('t', ['a'])).rejects.toBeInstanceOf(NativeUnavailableError)
  })
})

describe('有宿主', () => {
  it('pickDir：选中返回令牌与名字，取消返回 null', async () => {
    withHost()
    expect(await pickDir(fakeCall({ token: 'dir:1', name: '下载' }))).toEqual({ token: 'dir:1', name: '下载' })
    expect(await pickDir(fakeCall({ token: null, name: null }))).toBeNull()
  })
  it('listDirs / forgetDir', async () => {
    withHost()
    const call = fakeCall({ items: [{ token: 't', name: 'n' }] })
    expect(await listDirs(call)).toEqual([{ token: 't', name: 'n' }])
    const c2 = fakeCall({ forgotten: true })
    expect(await forgetDir('t', c2)).toBe(true)
    expect(c2).toHaveBeenCalledWith('native.dir.forget', { token: 't' })
  })
  it('scanDir：只传设置过的参数，不设超时，订阅进度并在结束后取消订阅', async () => {
    withHost()
    const result = { items: [], scanned: 3, truncated: false }
    const call = fakeCall(result)
    const off = vi.fn()
    let handler: ((d: unknown) => void) | null = null
    const on: OnFn = (_e, h) => {
      handler = h
      return off
    }
    const ac = new AbortController()
    const seen: number[] = []
    const r = await scanDir('t', { mode: 'large', minBytes: 100 }, { signal: ac.signal, onProgress: (n) => seen.push(n) }, call, on)
    expect(r).toBe(result)
    expect(call).toHaveBeenCalledWith('native.dir.scan', { token: 't', mode: 'large', minBytes: 100 }, { timeoutMs: 0, signal: ac.signal })
    handler!({ scanned: 500 })
    expect(seen).toEqual([500])
    expect(off).toHaveBeenCalledTimes(1)
  })
  it('scanDir：失败也会取消订阅', async () => {
    withHost()
    const off = vi.fn()
    const call = vi.fn(async () => {
      throw new Error('x')
    }) as unknown as CallFn
    await expect(scanDir('t', { mode: 'all' }, { onProgress: () => {} }, call, () => off)).rejects.toThrow('x')
    expect(off).toHaveBeenCalled()
  })
  it('deleteDirItems：透传并带取消信号', async () => {
    withHost()
    const ret = { deleted: 1, freedBytes: 5, failed: [] }
    const call = fakeCall(ret)
    const ac = new AbortController()
    expect(await deleteDirItems('t', ['a'], ac.signal, call)).toBe(ret)
    expect(call).toHaveBeenCalledWith('native.dir.delete', { token: 't', ids: ['a'] }, { timeoutMs: 0, signal: ac.signal })
  })
})
