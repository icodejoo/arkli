import { afterEach, describe, expect, it, vi } from 'vitest'

/** 带（或不带）宿主地加载一份全新的 reminder 与 system */
async function load(withHost: boolean) {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  const reminder = await import('./reminder')
  const system = await import('./system')
  return { ...reminder, NativeUnavailableError: system.NativeUnavailableError }
}

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as import('./system').CallFn & typeof fn
}

afterEach(() => vi.unstubAllGlobals())

describe('reminder', () => {
  it('showNotification：只带给了的字段，返回通知 id', async () => {
    const { showNotification } = await load(true)
    const call = fakeCall({ shown: true, id: 42 })
    expect(await showNotification({ title: '喝水' }, call)).toBe(42)
    expect(call).toHaveBeenCalledWith('native.notify.show', { title: '喝水' })
    await showNotification({ id: 1, title: 'a', text: 'b' }, call)
    expect(call).toHaveBeenLastCalledWith('native.notify.show', { title: 'a', id: 1, text: 'b' })
  })
  it('setAlarm / cancelAlarm / listAlarms', async () => {
    const { setAlarm, cancelAlarm, listAlarms } = await load(true)
    const set = fakeCall({ set: true })
    await setAlarm({ id: 'p', atEpochMs: 9, title: 't' }, set)
    expect(set).toHaveBeenCalledWith('native.alarm.set', { id: 'p', atEpochMs: 9, title: 't' })
    await setAlarm({ id: 'p', atEpochMs: 9, title: 't', text: 'x' }, set)
    expect(set).toHaveBeenLastCalledWith('native.alarm.set', { id: 'p', atEpochMs: 9, title: 't', text: 'x' })
    expect(await cancelAlarm('p', fakeCall({ cancelled: true }))).toBe(true)
    expect(await cancelAlarm('p', fakeCall({ cancelled: false }))).toBe(false)
    const items = [{ id: 'a', atEpochMs: 1, title: 't', text: '' }]
    expect(await listAlarms(fakeCall({ items }))).toEqual(items)
  })
  it('无宿主：全部抛 NativeUnavailableError', async () => {
    const m = await load(false)
    const call = fakeCall(null)
    await expect(m.showNotification({ title: 'a' }, call)).rejects.toBeInstanceOf(m.NativeUnavailableError)
    await expect(m.setAlarm({ id: 'a', atEpochMs: 1, title: 't' }, call)).rejects.toBeInstanceOf(m.NativeUnavailableError)
    await expect(m.cancelAlarm('a', call)).rejects.toBeInstanceOf(m.NativeUnavailableError)
    await expect(m.listAlarms(call)).rejects.toBeInstanceOf(m.NativeUnavailableError)
    expect(call).not.toHaveBeenCalled()
  })
})
