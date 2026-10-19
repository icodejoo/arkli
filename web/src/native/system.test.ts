import { afterEach, describe, expect, it, vi } from 'vitest'

/** 带（或不带）宿主地加载一份全新的 system */
async function load(withHost: boolean) {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  return import('./system')
}

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as import('./system').CallFn & typeof fn
}

afterEach(() => vi.unstubAllGlobals())

describe('clipboard', () => {
  it('有宿主：写剪贴板带 sensitive', async () => {
    const { clipboardWrite } = await load(true)
    const call = fakeCall({ written: true })
    expect(await clipboardWrite('abc', true, call)).toBe(true)
    expect(call).toHaveBeenCalledWith('native.clipboard.write', { text: 'abc', sensitive: true })
    await clipboardWrite('x', undefined, call)
    expect(call).toHaveBeenLastCalledWith('native.clipboard.write', { text: 'x', sensitive: false })
  })
  it('无宿主：写剪贴板退回 copyText', async () => {
    const { clipboardWrite } = await load(false)
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const call = fakeCall(null)
    expect(await clipboardWrite('abc', true, call)).toBe(true)
    expect(writeText).toHaveBeenCalledWith('abc')
    expect(call).not.toHaveBeenCalled()
  })
  it('有宿主：读剪贴板，拿不到是 null', async () => {
    const { clipboardRead } = await load(true)
    expect(await clipboardRead(fakeCall({ text: 'hi' }))).toBe('hi')
    expect(await clipboardRead(fakeCall({ text: null }))).toBeNull()
  })
  it('无宿主：读剪贴板走 navigator，失败或不支持为 null', async () => {
    const { clipboardRead } = await load(false)
    vi.stubGlobal('navigator', { clipboard: { readText: async () => 'web' } })
    expect(await clipboardRead()).toBe('web')
    vi.stubGlobal('navigator', {
      clipboard: {
        readText: async () => {
          throw new Error('denied')
        },
      },
    })
    expect(await clipboardRead()).toBeNull()
    vi.stubGlobal('navigator', {})
    expect(await clipboardRead()).toBeNull()
  })
})

describe('share', () => {
  it('有宿主：透传参数并返回 started', async () => {
    const { share } = await load(true)
    const call = fakeCall({ started: true })
    expect(await share({ path: 'cache/out/a.png', title: 't' }, call)).toBe(true)
    expect(call).toHaveBeenCalledWith('native.share', { path: 'cache/out/a.png', title: 't' })
    expect(await share({ text: 'x' }, fakeCall({ started: false }))).toBe(false)
  })
  it('无宿主：退回 navigator.share，只带文本', async () => {
    const { share } = await load(false)
    const nav = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { share: nav })
    expect(await share({ text: 'hi', title: 't', path: 'cache/out/a.png' })).toBe(true)
    expect(nav).toHaveBeenCalledWith({ text: 'hi', title: 't' })
  })
  it('无宿主：不支持、只有 path、用户取消都是 false', async () => {
    const { share } = await load(false)
    vi.stubGlobal('navigator', {})
    expect(await share({ text: 'hi' })).toBe(false)
    vi.stubGlobal('navigator', { share: vi.fn() })
    expect(await share({ path: 'cache/out/a.png' })).toBe(false)
    vi.stubGlobal('navigator', {
      share: async () => {
        throw new Error('AbortError')
      },
    })
    expect(await share({ text: 'hi' })).toBe(false)
  })
})

describe('settings / intent / processText', () => {
  it('openSettings 传 page 并返回 opened', async () => {
    const { openSettings } = await load(true)
    const call = fakeCall({ opened: true })
    expect(await openSettings('wifi', call)).toBe(true)
    expect(call).toHaveBeenCalledWith('native.settings.open', { page: 'wifi' })
    expect(await openSettings('app', fakeCall({ opened: false }))).toBe(false)
  })
  it('openIntent 传 kind 与 value', async () => {
    const { openIntent } = await load(true)
    const call = fakeCall({ opened: true })
    expect(await openIntent('dial', '10086', call)).toBe(true)
    expect(call).toHaveBeenCalledWith('native.intent.open', { kind: 'dial', value: '10086' })
  })
  it('processText 返回 handled', async () => {
    const { processText } = await load(true)
    const call = fakeCall({ handled: false })
    expect(await processText('hello', call)).toBe(false)
    expect(call).toHaveBeenCalledWith('native.intent.processText', { text: 'hello' })
    expect(await processText('x', fakeCall({ handled: true }))).toBe(true)
  })
  it('无宿主：settings / intent 抛明确错误，processText 为 false', async () => {
    const { openSettings, openIntent, processText, NativeUnavailableError } = await load(false)
    const call = fakeCall(null)
    await expect(openSettings('wifi', call)).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(openIntent('url', 'https://a.com', call)).rejects.toThrow('native.intent.open')
    expect(await processText('x', call)).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })
})

describe('vibrate', () => {
  it('有宿主：数组原样发，repeat 有才带', async () => {
    const { vibrate } = await load(true)
    const call = fakeCall({ vibrated: true })
    expect(await vibrate([0, 50, 30, 50], undefined, call)).toBe(true)
    expect(call).toHaveBeenCalledWith('native.haptic.vibrate', { pattern: [0, 50, 30, 50] })
    await vibrate([0, 50], 0, call)
    expect(call).toHaveBeenLastCalledWith('native.haptic.vibrate', { pattern: [0, 50], repeat: 0 })
  })
  it('有宿主：单个数字转成 [0, n]；没有马达返回 false', async () => {
    const { vibrate } = await load(true)
    const call = fakeCall({ vibrated: false })
    expect(await vibrate(80, undefined, call)).toBe(false)
    expect(call).toHaveBeenCalledWith('native.haptic.vibrate', { pattern: [0, 80] })
  })
  it('有宿主：cancelVibrate 发 cancel', async () => {
    const { cancelVibrate } = await load(true)
    const call = fakeCall({ vibrated: false })
    await cancelVibrate(call)
    expect(call).toHaveBeenCalledWith('native.haptic.vibrate', { cancel: true })
  })
  it('无宿主：退回 navigator.vibrate', async () => {
    const { vibrate, cancelVibrate } = await load(false)
    const nav = vi.fn((_: unknown) => true)
    vi.stubGlobal('navigator', { vibrate: nav })
    expect(await vibrate([0, 30])).toBe(true)
    expect(nav).toHaveBeenCalledWith([30])
    expect(await vibrate([20, 30])).toBe(true)
    expect(nav).toHaveBeenLastCalledWith([0, 20, 30])
    await cancelVibrate()
    expect(nav).toHaveBeenLastCalledWith(0)
    vi.stubGlobal('navigator', {})
    expect(await vibrate(30)).toBe(false)
    await expect(cancelVibrate()).resolves.toBeUndefined()
  })
})

describe('torch', () => {
  it('有宿主：发 { on } 并规范化结果', async () => {
    const { setTorch } = await load(true)
    const call = fakeCall({ on: true, available: true })
    expect(await setTorch(true, call)).toEqual({ on: true, available: true })
    expect(call).toHaveBeenCalledWith('native.torch.set', { on: true })
    expect(await setTorch(true, fakeCall({ on: false, available: false }))).toEqual({ on: false, available: false })
  })
  it('无宿主：抛 NativeUnavailableError', async () => {
    const { setTorch, NativeUnavailableError } = await load(false)
    const call = fakeCall({})
    await expect(setTorch(true, call)).rejects.toBeInstanceOf(NativeUnavailableError)
    expect(call).not.toHaveBeenCalled()
  })
})

describe('screen', () => {
  it('有宿主：三个方法发对应参数', async () => {
    const { keepAwake, setBrightness, setImmersive, setOrientation } = await load(true)
    const call = fakeCall({})
    await keepAwake(true, call)
    expect(call).toHaveBeenLastCalledWith('native.screen.keepAwake', { on: true })
    await setBrightness(-1, call)
    expect(call).toHaveBeenLastCalledWith('native.screen.brightness', { value: -1 })
    await setImmersive(false, call)
    expect(call).toHaveBeenLastCalledWith('native.screen.immersive', { on: false })
    await setOrientation('landscape', call)
    expect(call).toHaveBeenLastCalledWith('native.screen.orientation', { mode: 'landscape' })
  })
  it('无宿主：抛 NativeUnavailableError', async () => {
    const { keepAwake, setBrightness, setImmersive, setOrientation, NativeUnavailableError } = await load(false)
    const call = fakeCall({})
    await expect(keepAwake(true, call)).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(setBrightness(0.5, call)).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(setImmersive(true, call)).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(setOrientation('landscape', call)).rejects.toBeInstanceOf(NativeUnavailableError)
    expect(call).not.toHaveBeenCalled()
  })
})

describe('device', () => {
  it('有宿主：info / status / display 直接返回原生数据', async () => {
    const { deviceInfo, deviceStatus, deviceDisplay } = await load(true)
    const info = { brand: 'HUAWEI' }
    const call = fakeCall(info)
    expect(await deviceInfo(call)).toBe(info)
    expect(call).toHaveBeenLastCalledWith('native.device.info', {})
    await deviceStatus(call)
    expect(call).toHaveBeenLastCalledWith('native.device.status', {})
    await deviceDisplay(call)
    expect(call).toHaveBeenLastCalledWith('native.device.display', {})
  })
  it('无宿主：返回 null', async () => {
    const { deviceInfo, deviceStatus, deviceDisplay } = await load(false)
    const call = fakeCall({})
    expect(await deviceInfo(call)).toBeNull()
    expect(await deviceStatus(call)).toBeNull()
    expect(await deviceDisplay(call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})

describe('permission', () => {
  it('有宿主：check / request 传 name，原样返回 reason', async () => {
    const { checkPermission, requestPermission } = await load(true)
    const call = fakeCall({ granted: false, reason: 'not_declared' })
    expect(await checkPermission('camera', call)).toEqual({ granted: false, reason: 'not_declared' })
    expect(call).toHaveBeenLastCalledWith('native.permission.check', { name: 'camera' })
    await requestPermission('microphone', call)
    expect(call).toHaveBeenLastCalledWith('native.permission.request', { name: 'microphone' })
  })
  it('无宿主：抛 NativeUnavailableError', async () => {
    const { checkPermission, requestPermission, NativeUnavailableError } = await load(false)
    const call = fakeCall({})
    await expect(checkPermission('camera', call)).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(requestPermission('notifications', call)).rejects.toBeInstanceOf(NativeUnavailableError)
  })
})
