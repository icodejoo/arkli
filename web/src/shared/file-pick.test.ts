import { afterEach, describe, expect, it, vi } from 'vitest'

/** 带（或不带）宿主地加载一份全新的 file-pick */
async function load(withHost: boolean) {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  return import('./file-pick')
}

afterEach(() => vi.unstubAllGlobals())

describe('pickFile', () => {
  it('宿主内走 native.file.pick，默认 */*，读回成 File', async () => {
    const { pickFile } = await load(true)
    const call = vi.fn(async () => ({ items: [{ kind: 'file', url: '/files/pick/a.txt', name: 'a.txt', mime: 'text/plain' }], failed: [] }))
    const fetchMock = vi.fn(async () => ({ blob: async () => new Blob(['你好']) }))
    vi.stubGlobal('fetch', fetchMock)
    const f = await pickFile({}, call as never)
    expect(call).toHaveBeenCalledWith('native.file.pick', { mime: '*/*' }, { timeoutMs: 0 })
    expect(fetchMock).toHaveBeenCalledWith('/files/pick/a.txt')
    expect(f?.name).toBe('a.txt')
    expect(f?.type).toBe('text/plain')
    expect(await f?.text()).toBe('你好')
  })

  it('没给 url 时用 path 拼地址；mime 参数透传', async () => {
    const { pickFile } = await load(true)
    const call = vi.fn(async () => ({ items: [{ kind: 'file', path: 'cache/pick/b.md', name: 'b.md', mime: '' }] }))
    const fetchMock = vi.fn(async () => ({ blob: async () => new Blob(['x'], { type: 'text/markdown' }) }))
    vi.stubGlobal('fetch', fetchMock)
    const f = await pickFile({ mime: 'text/*' }, call as never)
    expect(call).toHaveBeenCalledWith('native.file.pick', { mime: 'text/*' }, { timeoutMs: 0 })
    expect(fetchMock).toHaveBeenCalledWith('/files/cache/pick/b.md')
    expect(f?.type).toBe('text/markdown')
  })

  it('取消返回 null 且不读文件；失败项走 onFailed', async () => {
    const { pickFile } = await load(true)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const onFailed = vi.fn()
    const call = vi.fn(async () => ({ items: [], failed: [{ name: 'big.log', message: '超过 64MB' }] }))
    expect(await pickFile({ onFailed }, call as never)).toBeNull()
    expect(onFailed).toHaveBeenCalledWith([{ name: 'big.log', message: '超过 64MB' }])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('视频项只有句柄读不了，跳过返回 null', async () => {
    const { pickFile } = await load(true)
    const call = vi.fn(async () => ({ items: [{ kind: 'video', name: 'v.mp4', mime: 'video/mp4' }] }))
    expect(await pickFile({}, call as never)).toBeNull()
  })

  it('无宿主退回 input，带上 accept，取消返回 null', async () => {
    const { pickFile } = await load(false)
    const listeners: Record<string, () => void> = {}
    const input = {
      type: '',
      accept: '',
      files: null as File[] | null,
      onchange: null as null | (() => void),
      addEventListener: (ev: string, fn: () => void) => (listeners[ev] = fn),
      click: vi.fn(),
    }
    vi.stubGlobal('document', { createElement: () => input })
    const call = vi.fn()
    const p1 = pickFile({ accept: '.txt' }, call as never)
    expect(input.type).toBe('file')
    expect(input.accept).toBe('.txt')
    expect(input.click).toHaveBeenCalled()
    const file = new File(['a'], 'a.txt')
    input.files = [file]
    input.onchange?.()
    expect(await p1).toBe(file)
    const p2 = pickFile({}, call as never)
    listeners.cancel()
    expect(await p2).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})
