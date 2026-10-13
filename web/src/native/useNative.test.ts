import { effectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 模拟宿主 */
interface FakeHost {
  postMessage: ReturnType<typeof vi.fn>
  onmessage: ((e: { data: unknown }) => void) | null
}

/** 已发出的请求 */
function sent(host: FakeHost): Array<{ id: string; method: string; params: Record<string, unknown> }> {
  return host.postMessage.mock.calls.map((c) => JSON.parse(c[0] as string))
}

/** 模拟原生回传 */
function reply(host: FakeHost, msg: unknown): void {
  host.onmessage?.({ data: JSON.stringify(msg) })
}

/** 带宿主地加载一份全新的 useNative 与它所用的 bridge */
async function load(withHost = true) {
  vi.resetModules()
  const host: FakeHost = { postMessage: vi.fn(), onmessage: null }
  vi.stubGlobal('window', withHost ? { ArkliNative: host } : {})
  const { useNative } = await import('./useNative')
  const scope = effectScope()
  const api = scope.run(() => useNative())!
  return { host, scope, api }
}

afterEach(() => vi.unstubAllGlobals())

describe('useNative', () => {
  it('loading 随并发请求计数，全部完成才变 false', async () => {
    const { host, api } = await load()
    const p1 = api.call('a.b.c')
    const p2 = api.call('a.b.d')
    expect(api.loading.value).toBe(true)
    reply(host, { v: 2, id: sent(host)[0].id, ok: true, data: 1 })
    await p1
    expect(api.loading.value).toBe(true)
    reply(host, { v: 2, id: sent(host)[1].id, ok: true, data: 2 })
    await p2
    expect(api.loading.value).toBe(false)
  })

  it('失败写入 error 且仍 reject；下次成功清空', async () => {
    const { host, api } = await load()
    const p1 = api.call('a.b.c')
    reply(host, { v: 2, id: sent(host)[0].id, ok: false, error: { code: 'BAD_PARAMS', message: 'x' } })
    await expect(p1).rejects.toMatchObject({ code: 'BAD_PARAMS' })
    expect(api.error.value).toEqual({ code: 'BAD_PARAMS', message: 'x' })
    expect(api.loading.value).toBe(false)
    const p2 = api.call('a.b.c')
    reply(host, { v: 2, id: sent(host)[1].id, ok: true, data: 1 })
    await p2
    expect(api.error.value).toBeNull()
  })

  it('不在容器内：NOT_READY 写入 error', async () => {
    const { api } = await load(false)
    await expect(api.call('a.b.c')).rejects.toMatchObject({ code: 'NOT_READY' })
    expect(api.error.value?.code).toBe('NOT_READY')
    expect(api.loading.value).toBe(false)
  })

  it('cancelAll 向原生发 native.task.cancel，CANCELLED 不写 error', async () => {
    const { host, api } = await load()
    const p = api.call('a.b.c', {}, { timeoutMs: 0 })
    const id = sent(host)[0].id
    api.cancelAll()
    expect(sent(host)[1]).toMatchObject({ method: 'native.task.cancel', params: { id } })
    reply(host, { v: 2, id, ok: false, error: { code: 'CANCELLED', message: 'c' } })
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(api.error.value).toBeNull()
    expect(api.loading.value).toBe(false)
  })

  it('on 订阅收到事件，作用域销毁后自动解绑', async () => {
    const { host, scope, api } = await load()
    const h = vi.fn()
    api.on('download.progress', h)
    reply(host, { v: 2, event: 'download.progress', data: 1 })
    expect(h).toHaveBeenCalledTimes(1)
    scope.stop()
    reply(host, { v: 2, event: 'download.progress', data: 2 })
    expect(h).toHaveBeenCalledTimes(1)
  })

  it('on 返回的解绑函数可手动调用', async () => {
    const { host, api } = await load()
    const h = vi.fn()
    const off = api.on('e', h)
    off()
    reply(host, { v: 2, event: 'e', data: 1 })
    expect(h).not.toHaveBeenCalled()
  })

  it('作用域销毁时自动取消在途请求', async () => {
    const { host, scope, api } = await load()
    const p = api.call('a.b.c', {}, { timeoutMs: 0 })
    p.catch(() => undefined)
    const id = sent(host)[0].id
    scope.stop()
    expect(sent(host)[1]).toMatchObject({ method: 'native.task.cancel', params: { id } })
  })

  it('外部 signal 中止同样取消', async () => {
    const { host, api } = await load()
    const ac = new AbortController()
    const p = api.call('a.b.c', {}, { timeoutMs: 0, signal: ac.signal })
    p.catch(() => undefined)
    ac.abort()
    expect(sent(host)[1]?.method).toBe('native.task.cancel')
  })
})
