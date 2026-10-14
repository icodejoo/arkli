import { afterEach, describe, expect, it, vi } from 'vitest'

/** 带（或不带）宿主地加载一份全新的 shortcut 与 system */
async function load(withHost: boolean) {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  const shortcut = await import('./shortcut')
  const system = await import('./system')
  return { ...shortcut, NativeUnavailableError: system.NativeUnavailableError }
}

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as import('./system').CallFn & typeof fn
}

afterEach(() => vi.unstubAllGlobals())

describe('shortcut', () => {
  it('有宿主：透传参数与结果', async () => {
    const { pinShortcut } = await load(true)
    const call = fakeCall({ requested: true })
    expect(await pinShortcut({ id: 'a', label: '知乎', url: 'https://zhihu.com' }, call)).toEqual({ requested: true })
    expect(call).toHaveBeenCalledWith('native.shortcut.pin', { id: 'a', label: '知乎', url: 'https://zhihu.com' })
    const unsupported = fakeCall({ requested: false, reason: 'unsupported' })
    expect(await pinShortcut({ id: 'a', label: 'x', url: 'https://a.com' }, unsupported)).toEqual({ requested: false, reason: 'unsupported' })
  })
  it('无宿主：抛 NativeUnavailableError', async () => {
    const { pinShortcut, NativeUnavailableError } = await load(false)
    await expect(pinShortcut({ id: 'a', label: 'x', url: 'https://a.com' }, fakeCall(null))).rejects.toBeInstanceOf(NativeUnavailableError)
  })
})
