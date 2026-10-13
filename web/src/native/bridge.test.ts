import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 模拟宿主对象：记录 postMessage 的请求，并暴露回传入口 */
interface FakeHost {
  postMessage: ReturnType<typeof vi.fn>
  onmessage: ((e: { data: unknown }) => void) | null
}

/** 已发出的请求（解析后） */
function sent(host: FakeHost): Array<{ id: string; method: string; params: Record<string, unknown> }> {
  return host.postMessage.mock.calls.map((c) => JSON.parse(c[0] as string))
}

/** 模拟原生回传一条消息 */
function reply(host: FakeHost, msg: unknown): void {
  host.onmessage?.({ data: JSON.stringify(msg) })
}

/** 带宿主地加载一份全新的 bridge 模块 */
async function load(withHost = true) {
  vi.resetModules()
  const host: FakeHost = { postMessage: vi.fn(), onmessage: null }
  vi.stubGlobal('window', withHost ? { ArkliNative: host } : {})
  const mod = await import('./bridge')
  return { host, ...mod }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('bridge.call', () => {
  it('响应成功时 resolve data，请求带 v2 与方法名', async () => {
    const { host, call } = await load()
    const p = call<{ pong: boolean }>('native.ping', { a: 1 })
    const [req] = sent(host)
    expect(req.method).toBe('native.ping')
    expect(req.params).toEqual({ a: 1 })
    reply(host, { v: 2, id: req.id, ok: true, data: { pong: true } })
    await expect(p).resolves.toEqual({ pong: true })
  })

  it('错误响应以 BridgeError 拒绝', async () => {
    const { host, call } = await load()
    const p = call('x.y.z')
    reply(host, { v: 2, id: sent(host)[0].id, ok: false, error: { code: 'UNKNOWN_METHOD', message: 'no' } })
    await expect(p).rejects.toEqual({ code: 'UNKNOWN_METHOD', message: 'no' })
  })

  it('未知 id 的响应被忽略，不影响在途请求', async () => {
    const { host, call } = await load()
    const p = call('a.b.c')
    reply(host, { v: 2, id: 'nope', ok: true, data: 1 })
    reply(host, { v: 2, id: sent(host)[0].id, ok: true, data: 2 })
    await expect(p).resolves.toBe(2)
  })

  it('非法 JSON 被忽略', async () => {
    const { host, call } = await load()
    const p = call('a.b.c')
    host.onmessage?.({ data: '{oops' })
    host.onmessage?.({ data: 123 })
    reply(host, { v: 2, id: sent(host)[0].id, ok: true, data: 'ok' })
    await expect(p).resolves.toBe('ok')
  })

  it('超时以 TIMEOUT 拒绝，迟到响应无副作用', async () => {
    const { host, call } = await load()
    const p = call('a.b.c', {}, { timeoutMs: 1000 })
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
    vi.advanceTimersByTime(1000)
    await assertion
    expect(() => reply(host, { v: 2, id: sent(host)[0].id, ok: true, data: 1 })).not.toThrow()
  })

  it('timeoutMs 为 0 时不超时', async () => {
    const { host, call } = await load()
    const p = call('a.b.c', {}, { timeoutMs: 0 })
    vi.advanceTimersByTime(10 * 60_000)
    reply(host, { v: 2, id: sent(host)[0].id, ok: true, data: 'late' })
    await expect(p).resolves.toBe('late')
  })

  it('默认 30 秒超时', async () => {
    const { call } = await load()
    const p = call('a.b.c')
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
    vi.advanceTimersByTime(30_000)
    await assertion
  })

  it('超时后通知原生取消该请求，避免选择器等任务在原生侧继续跑', async () => {
    const { host, call } = await load()
    const p = call('native.file.pick', {}, { timeoutMs: 1000 })
    const origId = sent(host)[0].id
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
    vi.advanceTimersByTime(1000)
    await assertion
    const cancel = sent(host)[1]
    expect(cancel.method).toBe('native.task.cancel')
    expect(cancel.params).toEqual({ id: origId })
  })

  it('取消调用自身超时不再追加取消，避免无限链', async () => {
    const { host, call } = await load()
    const p = call('native.task.cancel', { id: 'x' }, { timeoutMs: 1000 })
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
    vi.advanceTimersByTime(1000)
    await assertion
    expect(host.postMessage).toHaveBeenCalledTimes(1)
  })

  it('不在容器内时 NOT_READY', async () => {
    const { call } = await load(false)
    await expect(call('a.b.c')).rejects.toMatchObject({ code: 'NOT_READY' })
  })

  it('postMessage 同步抛错时以 INTERNAL 拒绝', async () => {
    const { host, call } = await load()
    host.postMessage.mockImplementation(() => {
      throw new TypeError('guard')
    })
    await expect(call('a.b.c')).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('signal 已中止时直接 CANCELLED，不发请求', async () => {
    const { host, call } = await load()
    const ac = new AbortController()
    ac.abort()
    await expect(call('a.b.c', {}, { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(host.postMessage).not.toHaveBeenCalled()
  })

  it('signal 中止时发 native.task.cancel，拒绝由原生的 CANCELLED 响应触发', async () => {
    const { host, call } = await load()
    const ac = new AbortController()
    const p = call('a.b.c', {}, { signal: ac.signal, timeoutMs: 0 })
    const origId = sent(host)[0].id
    ac.abort()
    const cancel = sent(host)[1]
    expect(cancel.method).toBe('native.task.cancel')
    expect(cancel.params).toEqual({ id: origId })
    reply(host, { v: 2, id: cancel.id, ok: true, data: { cancelled: true } })
    reply(host, { v: 2, id: origId, ok: false, error: { code: 'CANCELLED', message: 'c' } })
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('会话重建：原生对旧会话在途请求回 CANCELLED，页面按错误响应处理；迟到响应被丢弃', async () => {
    // 页面侧不感知会话号：WebView 重载时整个 JS 环境重来，原生保证旧响应不串到新页面
    const { host, call } = await load()
    const p = call('a.b.c', {}, { timeoutMs: 0 })
    const id = sent(host)[0].id
    reply(host, { v: 2, id, ok: false, error: { code: 'CANCELLED', message: '会话关闭' } })
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' })
    // 已结算的 id 再来响应属于未知 id，被忽略
    expect(() => reply(host, { v: 2, id, ok: true, data: 1 })).not.toThrow()
  })
})

describe('bridge.on', () => {
  it('事件分发给订阅者并带订阅号', async () => {
    const { host, on } = await load()
    const h = vi.fn()
    on('download.progress', h)
    reply(host, { v: 2, event: 'download.progress', sub: 's1', data: { percent: 42 } })
    expect(h).toHaveBeenCalledWith({ percent: 42 }, 's1')
  })

  it('取消订阅后不再收到；其他事件不触发', async () => {
    const { host, on } = await load()
    const h = vi.fn()
    const off = on('app.pause', h)
    reply(host, { v: 2, event: 'app.resume', data: null })
    expect(h).not.toHaveBeenCalled()
    off()
    reply(host, { v: 2, event: 'app.pause', data: null })
    expect(h).not.toHaveBeenCalled()
  })

  it('同一事件多个订阅者都收到', async () => {
    const { host, on } = await load()
    const a = vi.fn()
    const b = vi.fn()
    on('e', a)
    on('e', b)
    reply(host, { v: 2, event: 'e', data: 1 })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })
})

describe('bridge.hello', () => {
  it('结果缓存，失败后清缓存允许重试', async () => {
    const { host, hello } = await load()
    const p1 = hello()
    const p2 = hello()
    expect(sent(host)).toHaveLength(1)
    reply(host, { v: 2, id: sent(host)[0].id, ok: false, error: { code: 'INTERNAL', message: 'x' } })
    await expect(p1).rejects.toBeTruthy()
    await expect(p2).rejects.toBeTruthy()
    const p3 = hello()
    expect(sent(host)).toHaveLength(2)
    const data = { protocol: 2, session: 1, features: { binary: false } }
    reply(host, { v: 2, id: sent(host)[1].id, ok: true, data })
    await expect(p3).resolves.toEqual(data)
  })
})
