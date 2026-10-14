import { afterEach, describe, expect, it, vi } from 'vitest'

/** 带（或不带）宿主地加载一份全新的 qrcode 与 system */
async function load(withHost: boolean) {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  const qr = await import('./qrcode')
  const system = await import('./system')
  return { ...qr, NativeUnavailableError: system.NativeUnavailableError }
}

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as import('./system').CallFn & typeof fn
}

afterEach(() => vi.unstubAllGlobals())

describe('qrcode', () => {
  it('scanQr：不设超时，原样返回全部码', async () => {
    const { scanQr } = await load(true)
    const codes = [
      { text: 'a', format: 'QR_CODE', bytes: 'YQ==' },
      { text: '123', format: 'EAN_13', bytes: 'MTIz' },
    ]
    const call = fakeCall({ cancelled: false, results: codes })
    expect(await scanQr(call)).toEqual({ cancelled: false, results: codes })
    expect(call).toHaveBeenCalledWith('native.qrcode.scan', {}, { timeoutMs: 0 })
  })
  it('scanQr：取消时 results 为空，缺字段也有兜底', async () => {
    const { scanQr } = await load(true)
    expect(await scanQr(fakeCall({ cancelled: true, results: [] }))).toEqual({ cancelled: true, results: [] })
    expect(await scanQr(fakeCall({}))).toEqual({ cancelled: false, results: [] })
  })
  it('decodeQrImage：带 path 调用，空结果给空数组', async () => {
    const { decodeQrImage } = await load(true)
    const call = fakeCall({ results: [{ text: 'x', format: 'QR_CODE', bytes: 'eA==' }] })
    expect(await decodeQrImage('cache/pick/a.jpg', call)).toEqual([{ text: 'x', format: 'QR_CODE', bytes: 'eA==' }])
    expect(call).toHaveBeenCalledWith('native.qrcode.decodeImage', { path: 'cache/pick/a.jpg' })
    expect(await decodeQrImage('cache/pick/b.jpg', fakeCall({}))).toEqual([])
  })
  it('无宿主时都抛 NativeUnavailableError', async () => {
    const { scanQr, decodeQrImage, NativeUnavailableError } = await load(false)
    await expect(scanQr(fakeCall({}))).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(decodeQrImage('cache/pick/a.jpg', fakeCall({}))).rejects.toBeInstanceOf(NativeUnavailableError)
  })
})
