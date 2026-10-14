import { afterEach, describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import { compressVideo, extractAudio, extractFrames, mediaInfo, onMediaProgress, pickVideo, saveCachedFile } from './media'
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

/** 造一个可手动触发事件的 on，并记录退订次数 */
function fakeOn() {
  let handler: ((d: unknown) => void) | null = null
  const off = vi.fn()
  const on = vi.fn((_e: string, h: (d: unknown) => void) => {
    handler = h
    return off
  }) as unknown as OnFn & ReturnType<typeof vi.fn>
  return { on, off, fire: (d: unknown) => handler?.(d) }
}

afterEach(() => vi.unstubAllGlobals())

describe('无宿主', () => {
  it('全部抛 NativeUnavailableError', async () => {
    await expect(pickVideo()).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(mediaInfo('uri:1')).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(extractAudio('uri:1')).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(extractFrames('uri:1')).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(compressVideo('uri:1', 'low')).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(saveCachedFile('cache/out/a.m4a', 'a.m4a', 'audio/mp4')).rejects.toBeInstanceOf(NativeUnavailableError)
  })
})

describe('pickVideo', () => {
  it('按视频过滤发起选择并整理字段', async () => {
    withHost()
    const call = fakeCall({
      items: [{ kind: 'video', handle: 'uri:ab', name: 'a.mp4', mime: 'video/mp4', size: 1000, width: 1080, height: 1920, durationMs: 5000 }],
      failed: [],
    })
    const v = await pickVideo(call)
    expect(v).toEqual({ handle: 'uri:ab', name: 'a.mp4', size: 1000, durationMs: 5000, width: 1080, height: 1920 })
    expect(call).toHaveBeenCalledWith('native.file.pick', { mime: 'video/*', multiple: false, max: 1 }, { timeoutMs: 0 })
  })

  it('元数据缺失时对应字段为 undefined', async () => {
    withHost()
    const v = await pickVideo(fakeCall({ items: [{ kind: 'video', handle: 'uri:1', name: 'b.mp4', size: 5 }], failed: [] }))
    expect(v?.durationMs).toBeUndefined()
    expect(v?.width).toBeUndefined()
  })

  it('用户取消返回 null', async () => {
    withHost()
    expect(await pickVideo(fakeCall({ items: [], failed: [] }))).toBeNull()
  })

  it('选中的文件处理失败抛带提示的错误', async () => {
    withHost()
    await expect(pickVideo(fakeCall({ items: [], failed: [{ name: 'x', message: '读取失败' }] }))).rejects.toThrow('读取失败')
  })
})

describe('mediaInfo', () => {
  it('透传句柄并原样返回', async () => {
    withHost()
    const info = { durationMs: 1000, width: 1, height: 2, rotation: 90, bitrate: null, sizeBytes: 9, hasAudio: true, videoMime: 'video/avc', audioMime: null, fps: 30 }
    const call = fakeCall(info)
    expect(await mediaInfo('uri:1', call)).toEqual(info)
    expect(call).toHaveBeenCalledWith('native.media.info', { handle: 'uri:1' })
  })
})

describe('extractAudio', () => {
  it('只传给定的起止，长任务不设超时并带取消信号', async () => {
    withHost()
    const call = fakeCall({ path: 'cache/out/a.m4a', name: 'a.m4a', mime: 'audio/mp4', bytes: 1, durationMs: 1 })
    const ac = new AbortController()
    const { on } = fakeOn()
    await extractAudio('uri:1', { startMs: 1000 }, { signal: ac.signal }, call, on)
    const [method, params, opts] = call.mock.calls[0] as unknown as [string, Record<string, unknown>, { timeoutMs: number; signal: AbortSignal }]
    expect(method).toBe('native.media.extractAudio')
    expect(params).toEqual({ handle: 'uri:1', startMs: 1000 })
    expect(opts.timeoutMs).toBe(0)
    expect(opts.signal).toBe(ac.signal)
  })

  it('进度事件转给回调，结束后退订', async () => {
    withHost()
    const { on, off, fire } = fakeOn()
    const seen: Array<{ done: number; total: number }> = []
    const call = vi.fn(async () => {
      fire({ done: 500, total: 1000 })
      return { path: 'p', name: 'n', mime: 'audio/mp4', bytes: 1, durationMs: 1 }
    }) as unknown as CallFn
    await extractAudio('uri:1', {}, { onProgress: (p) => seen.push(p) }, call, on)
    expect(seen).toEqual([{ done: 500, total: 1000 }])
    expect(on).toHaveBeenCalledWith('media.progress', expect.any(Function))
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('调用失败也退订', async () => {
    withHost()
    const { on, off } = fakeOn()
    const call = vi.fn(async () => {
      throw new Error('该视频的音轨编码暂不支持直接提取')
    }) as unknown as CallFn
    await expect(extractAudio('uri:1', {}, { onProgress: () => undefined }, call, on)).rejects.toThrow('暂不支持')
    expect(off).toHaveBeenCalledTimes(1)
  })
})

describe('extractFrames', () => {
  it('值为 undefined 的项不传', async () => {
    withHost()
    const call = fakeCall({ frames: [], width: 1, height: 1 })
    await extractFrames('uri:1', { startMs: 0, fps: 8, maxEdge: undefined }, {}, call, fakeOn().on)
    expect((call.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).toEqual({ handle: 'uri:1', startMs: 0, fps: 8 })
  })
})

describe('compressVideo', () => {
  it('传句柄与预设，返回结果', async () => {
    withHost()
    const res = { path: 'cache/out/v.mp4', name: 'v.mp4', bytes: 5, srcBytes: 10, ratio: 0.5, durationMs: 1000 }
    const call = fakeCall(res)
    expect(await compressVideo('uri:1', 'medium', {}, call, fakeOn().on)).toEqual(res)
    expect((call.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).toEqual({ handle: 'uri:1', preset: 'medium' })
  })
})

describe('onMediaProgress', () => {
  it('忽略格式不对的事件', () => {
    const { on, fire } = fakeOn()
    const handler = vi.fn()
    onMediaProgress(handler, on)
    fire(null)
    fire({ done: 'x', total: 1 })
    fire({ done: 1, total: 2 })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ done: 1, total: 2 })
  })
})

describe('saveCachedFile', () => {
  it('把缓存路径交给 native.file.save 并返回第一项', async () => {
    withHost()
    const item = { uri: 'content://x/1', name: 'a.m4a', size: 10, dir: 'Music/Arkli' }
    const call = fakeCall({ items: [item], failed: [] })
    expect(await saveCachedFile('cache/out/a.m4a', 'a.m4a', 'audio/mp4', call)).toEqual(item)
    expect(call).toHaveBeenCalledWith('native.file.save', { items: [{ path: 'cache/out/a.m4a', name: 'a.m4a', mime: 'audio/mp4' }] }, { timeoutMs: 0 })
  })
})
