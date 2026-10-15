import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import type { ModelApi, ModelEnsureResult, ModelStatus } from './model'

/** 被测函数；bridge 在加载时会访问 window，所以先桩掉再动态导入 */
let useModelState: typeof import('./useModelState').useModelState

beforeAll(async () => {
  vi.stubGlobal('window', {})
  useModelState = (await import('./useModelState')).useModelState
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** 造一个状态 */
function st(over: Partial<ModelStatus> = {}): ModelStatus {
  return { id: 'm', displayName: '模型', version: '1', state: 'absent', totalBytes: 1000, downloadedBytes: 0, diskBytes: 0, ...over }
}

/** 造假 api，每个方法都是可编程的 mock */
function fakeApi(over: Partial<ModelApi> = {}): ModelApi & { [K in keyof ModelApi]: ReturnType<typeof vi.fn> } {
  const api = {
    status: vi.fn(async () => st()),
    ensure: vi.fn(async () => ({ ...st({ state: 'downloading' }), started: true, meteredHint: false }) as ModelEnsureResult),
    cancel: vi.fn(async () => st({ downloadedBytes: 300, diskBytes: 300 })),
    remove: vi.fn(async () => st()),
    verify: vi.fn(async () => st({ state: 'installed', downloadedBytes: 1000, diskBytes: 1000 })),
    ...over,
  }
  return api as never
}

describe('useModelState', () => {
  it('探测前：ready 为 false，状态按 absent，进度 0', () => {
    const m = useModelState('m', fakeApi())
    expect(m.ready.value).toBe(false)
    expect(m.state.value).toBe('absent')
    expect(m.progress.value).toBe(0)
    expect(m.installed.value).toBe(false)
    m.dispose()
  })

  it('refresh：写入状态与进度，ready 置位', async () => {
    const api = fakeApi({ status: vi.fn(async () => st({ state: 'installed', downloadedBytes: 1000, diskBytes: 1000 })) })
    const m = useModelState('m', api)
    await m.refresh()
    expect(m.ready.value).toBe(true)
    expect(m.installed.value).toBe(true)
    expect(m.progress.value).toBe(1)
    expect(api.status).toHaveBeenCalledWith('m')
  })

  it('refresh 抛错：记入 error，ready 仍置位', async () => {
    const api = fakeApi({
      status: vi.fn(async () => {
        throw { code: 'BAD_PARAMS', message: '未知的模型 id' }
      }),
    })
    const m = useModelState('m', api)
    await m.refresh()
    expect(m.ready.value).toBe(true)
    expect(m.error.value).toEqual({ code: 'BAD_PARAMS', message: '未知的模型 id' })
  })

  it('start：ensure 后进入下载中并按间隔轮询，完成后自动停止', async () => {
    const seq = [200, 600, 1000]
    let i = 0
    const api = fakeApi({
      status: vi.fn(async () => {
        const done = seq[i++]
        return st(done >= 1000 ? { state: 'installed', downloadedBytes: 1000 } : { state: 'downloading', downloadedBytes: done, speedBps: 100 })
      }),
    })
    const m = useModelState('m', api, 500)
    await m.start()
    expect(m.downloading.value).toBe(true)
    expect(api.ensure).toHaveBeenCalledWith('m')

    await vi.advanceTimersByTimeAsync(500)
    expect(m.progress.value).toBe(0.2)
    await vi.advanceTimersByTimeAsync(500)
    expect(m.progress.value).toBe(0.6)
    await vi.advanceTimersByTimeAsync(500)
    expect(m.installed.value).toBe(true)
    // 装好后不再轮询
    const calls = api.status.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api.status.mock.calls.length).toBe(calls)
  })

  it('start：带出计费网络提示', async () => {
    const api = fakeApi({ ensure: vi.fn(async () => ({ ...st({ state: 'downloading' }), started: true, meteredHint: true })) })
    const m = useModelState('m', api)
    await m.start()
    expect(m.meteredHint.value).toBe(true)
    m.dispose()
  })

  it('下载失败：状态回到 absent 并带出原生记录的错误，轮询停止', async () => {
    const api = fakeApi({
      status: vi.fn(async () => st({ state: 'absent', downloadedBytes: 400, error: { code: 'NETWORK', message: '断了' } })),
    })
    const m = useModelState('m', api, 500)
    await m.start()
    await m.refresh()
    expect(m.state.value).toBe('absent')
    expect(m.error.value?.code).toBe('NETWORK')
    expect(m.progress.value).toBe(0.4)
    const n = api.status.mock.calls.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.status.mock.calls.length).toBe(n)
  })

  it('cancel：停轮询，保留已下载进度', async () => {
    const api = fakeApi({ status: vi.fn(async () => st({ state: 'downloading', downloadedBytes: 300 })) })
    const m = useModelState('m', api, 500)
    await m.refresh()
    expect(m.downloading.value).toBe(true)
    await m.cancel()
    expect(api.cancel).toHaveBeenCalledWith('m')
    expect(m.state.value).toBe('absent')
    expect(m.progress.value).toBe(0.3)
    const n = api.status.mock.calls.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.status.mock.calls.length).toBe(n)
  })

  it('remove 与 verify：更新状态', async () => {
    const api = fakeApi()
    const m = useModelState('m', api)
    await m.verify()
    expect(m.installed.value).toBe(true)
    await m.remove()
    expect(api.remove).toHaveBeenCalledWith('m')
    expect(m.state.value).toBe('absent')
    expect(m.progress.value).toBe(0)
  })

  it('操作抛错：不抛给页面，写入 error，busy 复位', async () => {
    const api = fakeApi({
      verify: vi.fn(async () => {
        throw { code: 'NOT_READY', message: '模型正在下载' }
      }),
    })
    const m = useModelState('m', api)
    await expect(m.verify()).resolves.toBeUndefined()
    expect(m.error.value).toEqual({ code: 'NOT_READY', message: '模型正在下载' })
    expect(m.busy.value).toBe(false)
  })

  it('busy：操作进行中为 true', async () => {
    let release: () => void = () => {}
    const api = fakeApi({ remove: vi.fn(() => new Promise<ModelStatus>((r) => (release = () => r(st())))) })
    const m = useModelState('m', api)
    const p = m.remove()
    expect(m.busy.value).toBe(true)
    release()
    await p
    expect(m.busy.value).toBe(false)
  })

  it('轮询出错：记录错误并停止，等页面手动 refresh', async () => {
    let n = 0
    const api = fakeApi({
      status: vi.fn(async () => {
        n++
        if (n === 1) return st({ state: 'downloading', downloadedBytes: 100 })
        throw { code: 'INTERNAL', message: 'x' }
      }),
    })
    const m = useModelState('m', api, 500)
    await m.refresh()
    await vi.advanceTimersByTimeAsync(500)
    expect(m.error.value?.code).toBe('INTERNAL')
    const calls = api.status.mock.calls.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.status.mock.calls.length).toBe(calls)
  })

  it('在 effect scope 里创建：scope 停止时自动停轮询', async () => {
    const api = fakeApi({ status: vi.fn(async () => st({ state: 'downloading', downloadedBytes: 100 })) })
    const scope = effectScope()
    const m = scope.run(() => useModelState('m', api, 500))!
    await m.refresh()
    await vi.advanceTimersByTimeAsync(500)
    const n = api.status.mock.calls.length
    expect(n).toBeGreaterThan(1)
    scope.stop()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.status.mock.calls.length).toBe(n)
  })

  it('进度不会超过 1，总字节为 0 时为 0', async () => {
    const api = fakeApi({ status: vi.fn(async () => st({ downloadedBytes: 2000 })) })
    const m = useModelState('m', api)
    await m.refresh()
    expect(m.progress.value).toBe(1)
    const z = useModelState('m', fakeApi({ status: vi.fn(async () => st({ totalBytes: 0 })) }))
    await z.refresh()
    expect(z.progress.value).toBe(0)
  })
})
