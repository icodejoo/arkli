import { afterEach, describe, expect, it, vi } from 'vitest'

/** 带（或不带）宿主地加载一份全新的 image-io */
async function load(withHost: boolean) {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  return import('./image-io')
}

/** 把 latin1 帧还原成字节 */
function fromLatin1(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0))
}

afterEach(() => vi.unstubAllGlobals())

describe('encodeChunk / pickEncoding', () => {
  it('latin1 每字符一字节，base64 可还原', async () => {
    const { encodeChunk } = await load(false)
    const bytes = new Uint8Array([0, 1, 127, 128, 255])
    expect(fromLatin1(encodeChunk(bytes, 'latin1'))).toEqual([0, 1, 127, 128, 255])
    expect(encodeChunk(bytes, 'base64')).toBe(btoa(String.fromCharCode(0, 1, 127, 128, 255)))
  })
  it('大块不爆栈', async () => {
    const { encodeChunk } = await load(false)
    const big = new Uint8Array(1024 * 1024).fill(65)
    expect(encodeChunk(big, 'latin1')).toHaveLength(1024 * 1024)
  })
  it('优先 latin1，兜底 base64', async () => {
    const { pickEncoding } = await load(false)
    expect(pickEncoding(['latin1', 'base64'])).toBe('latin1')
    expect(pickEncoding(['base64'])).toBe('base64')
    expect(pickEncoding(undefined)).toBe('base64')
  })
})

describe('writeBlobToCache', () => {
  it('按 seq/offset 串行分块写入并关闭', async () => {
    const { writeBlobToCache } = await load(false)
    const log: Array<{ m: string; p: Record<string, unknown> }> = []
    const call = vi.fn(async (m: string, p: Record<string, unknown> = {}) => {
      log.push({ m, p })
      if (m === 'native.file.openWrite') return { handle: 'h1', chunkBytes: 4, encodings: ['latin1', 'base64'] }
      if (m === 'native.file.closeWrite') return { path: 'cache/out/h1/a.bin' }
      return { seq: p.seq, written: 0 }
    })
    const path = await writeBlobToCache(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])]), 'a.bin', call as never)
    expect(path).toBe('cache/out/h1/a.bin')
    const writes = log.filter((l) => l.m === 'native.file.write').map((l) => l.p)
    expect(writes.map((w) => [w.seq, w.offset, (w.data as string).length])).toEqual([[0, 0, 4], [1, 4, 4], [2, 8, 2]])
    expect(writes[0].encoding).toBe('latin1')
    expect(log[0].p).toEqual({ name: 'a.bin', size: 10 })
    expect(log[log.length - 1]).toEqual({ m: 'native.file.closeWrite', p: { handle: 'h1', size: 10 } })
  })

  it('不支持 latin1 时用 base64', async () => {
    const { writeBlobToCache } = await load(false)
    const call = vi.fn(async (m: string, _p?: Record<string, unknown>) => {
      if (m === 'native.file.openWrite') return { handle: 'h', chunkBytes: 1024, encodings: ['base64'] }
      if (m === 'native.file.closeWrite') return { path: 'p' }
      return {}
    })
    await writeBlobToCache(new Blob([new Uint8Array([255, 0])]), 'a', call as never)
    const w = call.mock.calls.find((c) => c[0] === 'native.file.write')!
    expect(w[1]).toMatchObject({ encoding: 'base64', data: btoa(String.fromCharCode(255, 0)) })
  })

  it('写失败时 abort 句柄并抛原错误', async () => {
    const { writeBlobToCache } = await load(false)
    const call = vi.fn(async (m: string) => {
      if (m === 'native.file.openWrite') return { handle: 'h', chunkBytes: 4 }
      if (m === 'native.file.write') throw { code: 'INTERNAL', message: '磁盘满' }
      return {}
    })
    await expect(writeBlobToCache(new Blob([new Uint8Array(8)]), 'a', call as never)).rejects.toMatchObject({ code: 'INTERNAL' })
    expect(call).toHaveBeenLastCalledWith('native.file.closeWrite', { handle: 'h', abort: true })
  })
})

describe('saveBlobs', () => {
  it('有宿主：逐个写缓存后一次性 native.file.save，并回调进度', async () => {
    const { saveBlobs } = await load(true)
    const call = vi.fn(async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'native.file.openWrite') return { handle: `h-${p.name}`, chunkBytes: 1024, encodings: ['latin1'] }
      if (m === 'native.file.closeWrite') return { path: `cache/out/${p.handle}` }
      if (m === 'native.file.save') return { items: (p.items as unknown[]).map(() => ({})) }
      return {}
    })
    const progress = vi.fn()
    const res = await saveBlobs(
      [
        { name: 'a.jpg', blob: new Blob([new Uint8Array(3)], { type: 'image/jpeg' }) },
        { name: 'b.png', blob: new Blob([new Uint8Array(3)], { type: 'image/png' }) },
      ],
      progress,
      call as never,
    )
    expect(res).toEqual({ mode: 'native', saved: 2 })
    expect(progress.mock.calls).toEqual([[1, 2], [2, 2]])
    const save = call.mock.calls.filter((c) => c[0] === 'native.file.save')
    expect(save).toHaveLength(1)
    expect(save[0][1]).toEqual({
      items: [
        { path: 'cache/out/h-a.jpg', name: 'a.jpg', mime: 'image/jpeg' },
        { path: 'cache/out/h-b.png', name: 'b.png', mime: 'image/png' },
      ],
    })
  })

  it('无宿主：逐个触发 a[download]', async () => {
    const { saveBlobs } = await load(false)
    const clicks: Array<{ download: string; href: string }> = []
    const anchor = () => {
      const a = { href: '', download: '', style: {}, click() { clicks.push({ download: this.download, href: this.href }) }, remove() {} }
      return a
    }
    vi.stubGlobal('document', { createElement: anchor, body: { appendChild: () => undefined } })
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined })
    vi.useFakeTimers()
    const res = await saveBlobs([
      { name: 'a.jpg', blob: new Blob(['x']) },
      { name: 'b.jpg', blob: new Blob(['y']) },
    ])
    vi.useRealTimers()
    expect(res).toEqual({ mode: 'download', saved: 2 })
    expect(clicks.map((c) => c.download)).toEqual(['a.jpg', 'b.jpg'])
  })
})

describe('loadBitmap', () => {
  it('超限图片不解码，直接抛 ImageTooLargeError', async () => {
    const { loadBitmap, ImageTooLargeError } = await load(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const img = { name: 'x', mime: 'image/png', size: 1, width: 20000, height: 20000, url: '/x', release: () => undefined }
    await expect(loadBitmap(img)).rejects.toBeInstanceOf(ImageTooLargeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('正常图片：先尝试 from-image，失败回退无参', async () => {
    const { loadBitmap } = await load(false)
    vi.stubGlobal('fetch', async () => ({ blob: async () => new Blob(['x']) }))
    const bmp = { width: 10, height: 10, close: vi.fn() }
    const cib = vi.fn().mockRejectedValueOnce(new Error('opt')).mockResolvedValueOnce(bmp)
    vi.stubGlobal('createImageBitmap', cib)
    const img = { name: 'x', mime: 'image/png', size: 1, width: 10, height: 10, url: '/x', release: () => undefined }
    await expect(loadBitmap(img)).resolves.toBe(bmp)
    expect(cib).toHaveBeenCalledTimes(2)
    expect(cib.mock.calls[0][1]).toEqual({ imageOrientation: 'from-image' })
  })
})
