import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PickedImage } from './image-io'
import type { CameraResult } from '@/native/camera'

vi.mock('vant', () => ({ showToast: vi.fn() }))

/** 带无宿主 window 地加载一份全新的 shootPhoto（bridge 模块加载时会读 window） */
async function load() {
  vi.resetModules()
  vi.stubGlobal('window', {})
  return (await import('./shootPhoto')).shootPhoto
}

afterEach(() => vi.unstubAllGlobals())

/** 造一张兜底选图 */
const fakeImg = { name: 'a.png', url: 'blob:a', width: 1, height: 1 } as PickedImage

describe('shootPhoto', () => {
  it('有宿主：拍到照片就转成选图结果，并只开拍照模式', async () => {
    const shootPhoto = await load()
    const capture = vi.fn(async (): Promise<CameraResult> => ({ kind: 'image', path: 'cache/pick/cam/c.jpg', name: 'c.jpg', mime: 'image/jpeg', size: 1, width: 2, height: 3 }))
    const img = await shootPhoto({ hasHost: () => true, capture })
    expect(capture).toHaveBeenCalledWith({ modes: ['photo'] })
    expect(img?.path).toBe('cache/pick/cam/c.jpg')
    expect([img?.width, img?.height]).toEqual([2, 3])
  })
  it('有宿主：取消、选相册、拍到视频都返回 null', async () => {
    const shootPhoto = await load()
    for (const r of [{ cancelled: true }, { album: true }, { kind: 'video', path: 'p', name: 'v', mime: 'video/mp4', size: 1, width: 1, height: 1 }] as CameraResult[]) {
      expect(await shootPhoto({ hasHost: () => true, capture: async () => r })).toBeNull()
    }
  })
  it('无宿主：退回浏览器选图，不碰相机', async () => {
    const shootPhoto = await load()
    const capture = vi.fn()
    const fallback = vi.fn(async () => [fakeImg])
    expect(await shootPhoto({ hasHost: () => false, capture: capture as never, fallback })).toBe(fakeImg)
    expect(capture).not.toHaveBeenCalled()
    expect(await shootPhoto({ hasHost: () => false, fallback: async () => [] })).toBeNull()
  })
  it('失败：toast 错误信息并返回 null，没有信息用兜底文案', async () => {
    const shootPhoto = await load()
    const toast = vi.fn()
    expect(await shootPhoto({ hasHost: () => true, capture: async () => { throw new Error('没权限') }, toast })).toBeNull()
    expect(toast).toHaveBeenLastCalledWith('没权限')
    await shootPhoto({ hasHost: () => true, capture: async () => { throw {} }, toast })
    expect(toast).toHaveBeenLastCalledWith('拍照失败')
  })
})
