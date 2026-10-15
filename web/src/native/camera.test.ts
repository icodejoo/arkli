import { afterEach, describe, expect, it, vi } from 'vitest'

/** 带（或不带）宿主地加载一份全新的 camera 与 system */
async function load(withHost: boolean) {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  const cam = await import('./camera')
  const system = await import('./system')
  return { ...cam, NativeUnavailableError: system.NativeUnavailableError }
}

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as import('./system').CallFn & typeof fn
}

afterEach(() => vi.unstubAllGlobals())

describe('camera', () => {
  it('captureCamera：不设超时并透传参数', async () => {
    const { captureCamera } = await load(true)
    const call = fakeCall({ album: true })
    const r = await captureCamera({ modes: ['photo', 'album'] }, call)
    expect(r).toEqual({ album: true })
    expect(call).toHaveBeenCalledWith('native.camera.capture', { modes: ['photo', 'album'] }, { timeoutMs: 0 })
  })

  it('captureCamera：无宿主抛 NativeUnavailableError', async () => {
    const { captureCamera, NativeUnavailableError } = await load(false)
    await expect(captureCamera({}, fakeCall({}))).rejects.toBeInstanceOf(NativeUnavailableError)
  })

  it('isCancelled / isAlbum 判定', async () => {
    const { isCancelled, isAlbum } = await load(true)
    expect(isCancelled({ cancelled: true })).toBe(true)
    expect(isAlbum({ album: true })).toBe(true)
    expect(isAlbum({ cancelled: true })).toBe(false)
    expect(isCancelled({ album: true })).toBe(false)
  })

  it('clearCamera：返回删除数，失败与无宿主都返回 0', async () => {
    const { clearCamera } = await load(true)
    expect(await clearCamera(fakeCall({ cleared: true, count: 2 }))).toBe(2)
    const bad = vi.fn(async () => {
      throw new Error('x')
    }) as unknown as import('./system').CallFn
    expect(await clearCamera(bad)).toBe(0)
    const off = await load(false)
    expect(await off.clearCamera(fakeCall({ cleared: true, count: 5 }))).toBe(0)
  })

  it('cameraItemToPicked：url 走 /files/ 前缀并保留 path', async () => {
    const { cameraItemToPicked } = await load(true)
    const img = cameraItemToPicked({
      kind: 'image', path: 'cache/pick/cam/cam_a.jpg', name: 'cam_a.jpg', mime: 'image/jpeg', size: 10, width: 3, height: 4,
    })
    expect(img.url).toBe('/files/cache/pick/cam/cam_a.jpg')
    expect(img.path).toBe('cache/pick/cam/cam_a.jpg')
    expect([img.width, img.height]).toEqual([3, 4])
    expect(() => img.release()).not.toThrow()
  })
})

describe('pickOrCapture', () => {
  /** 造一张拍到的照片 */
  const photo = { kind: 'image', path: 'cache/pick/cam/cam_a.jpg', name: 'cam_a.jpg', mime: 'image/jpeg', size: 1, width: 3, height: 4 }
  /** 造一张相册里选的图 */
  const albumImg = { name: 'a.jpg', mime: 'image/jpeg', size: 1, width: 1, height: 1, url: '/files/a.jpg', release: () => undefined }

  it('直接拍到', async () => {
    const { pickOrCapture } = await load(true)
    const capture = vi.fn(async () => photo)
    const r = await pickOrCapture({}, { capture: capture as never, hasHost: () => true })
    expect(r?.path).toBe(photo.path)
    expect(capture).toHaveBeenCalledWith({ modes: ['photo', 'album'] })
  })

  it('拍照 -> 相册 -> 选到', async () => {
    const { pickOrCapture } = await load(true)
    const capture = vi.fn(async () => ({ album: true }))
    const pick = vi.fn(async (_o: unknown) => ({ images: [albumImg], camera: false }))
    const r = await pickOrCapture({}, { capture: capture as never, pick: pick as never, hasHost: () => true })
    expect(r).toBe(albumImg)
    expect(pick.mock.calls[0][0]).toMatchObject({ camera: true, multiple: false })
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('拍照 -> 相册 -> 点拍照图标 -> 再拍到', async () => {
    const { pickOrCapture } = await load(true)
    const capture = vi.fn().mockResolvedValueOnce({ album: true }).mockResolvedValueOnce(photo)
    const pick = vi.fn(async () => ({ images: [], camera: true }))
    const r = await pickOrCapture({}, { capture: capture as never, pick: pick as never, hasHost: () => true })
    expect(r?.path).toBe(photo.path)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('相册取消 -> 回拍照 -> 取消退出返回 null', async () => {
    const { pickOrCapture } = await load(true)
    const capture = vi.fn().mockResolvedValueOnce({ album: true }).mockResolvedValueOnce({ cancelled: true })
    const pick = vi.fn(async () => ({ images: [], camera: false }))
    const r = await pickOrCapture({}, { capture: capture as never, pick: pick as never, hasHost: () => true })
    expect(r).toBeNull()
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('无宿主回退到 input 选图', async () => {
    const { pickOrCapture } = await load(false)
    const capture = vi.fn()
    const fallback = vi.fn(async () => [albumImg])
    const r = await pickOrCapture({}, { capture: capture as never, fallback: fallback as never, hasHost: () => false })
    expect(r).toBe(albumImg)
    expect(capture).not.toHaveBeenCalled()
  })

  it('video 结果忽略并回到拍照', async () => {
    const { pickOrCapture } = await load(true)
    const capture = vi.fn().mockResolvedValueOnce({ ...photo, kind: 'video' }).mockResolvedValueOnce(photo)
    const r = await pickOrCapture({}, { capture: capture as never, hasHost: () => true })
    expect(r?.path).toBe(photo.path)
    expect(capture).toHaveBeenCalledTimes(2)
  })
})
