import { afterEach, describe, expect, it, vi } from 'vitest'

/** 带（或不带）宿主地加载一份全新的 apps 与 system */
async function load(withHost: boolean) {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  const apps = await import('./apps')
  const system = await import('./system')
  return { ...apps, NativeUnavailableError: system.NativeUnavailableError }
}

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as import('./system').CallFn & typeof fn
}

afterEach(() => vi.unstubAllGlobals())

describe('apps', () => {
  it('listApps：默认不含系统应用', async () => {
    const { listApps } = await load(true)
    const call = fakeCall({ items: [{ pkg: 'a.b' }] })
    expect(await listApps(undefined, call)).toEqual([{ pkg: 'a.b' }])
    expect(call).toHaveBeenCalledWith('native.apps.list', { includeSystem: false })
    await listApps(true, call)
    expect(call).toHaveBeenLastCalledWith('native.apps.list', { includeSystem: true })
  })
  it('openApp / openAppSettings 返回是否成功', async () => {
    const { openApp, openAppSettings } = await load(true)
    const call = fakeCall({ opened: true })
    expect(await openApp('a.b', call)).toBe(true)
    expect(call).toHaveBeenCalledWith('native.apps.open', { pkg: 'a.b' })
    expect(await openAppSettings('a.b', fakeCall({ opened: false }))).toBe(false)
  })
  it('exportApk：不设超时，带取消信号', async () => {
    const { exportApk } = await load(true)
    const call = fakeCall({ path: 'cache/out/x.apk', name: 'x.apk', bytes: 3 })
    const ac = new AbortController()
    expect(await exportApk('a.b', ac.signal, call)).toEqual({ path: 'cache/out/x.apk', name: 'x.apk', bytes: 3 })
    expect(call).toHaveBeenCalledWith('native.apps.exportApk', { pkg: 'a.b' }, { timeoutMs: 0, signal: ac.signal })
  })
  it('appIcon：size 可选；appFileUrl 拼同源路径', async () => {
    const { appIcon, appFileUrl } = await load(true)
    const call = fakeCall({ path: 'cache/out/app-icons/a.png' })
    expect(await appIcon('a.b', undefined, call)).toBe('cache/out/app-icons/a.png')
    expect(call).toHaveBeenCalledWith('native.apps.icon', { pkg: 'a.b' })
    await appIcon('a.b', 64, call)
    expect(call).toHaveBeenLastCalledWith('native.apps.icon', { pkg: 'a.b', size: 64 })
    expect(appFileUrl('cache/out/a.png')).toBe('/files/cache/out/a.png')
  })
  it('无宿主：抛 NativeUnavailableError', async () => {
    const m = await load(false)
    const call = fakeCall(null)
    await expect(m.listApps(false, call)).rejects.toBeInstanceOf(m.NativeUnavailableError)
    await expect(m.openApp('a.b', call)).rejects.toBeInstanceOf(m.NativeUnavailableError)
    await expect(m.openAppSettings('a.b', call)).rejects.toBeInstanceOf(m.NativeUnavailableError)
    await expect(m.exportApk('a.b', undefined, call)).rejects.toBeInstanceOf(m.NativeUnavailableError)
    await expect(m.appIcon('a.b', undefined, call)).rejects.toBeInstanceOf(m.NativeUnavailableError)
  })
})
