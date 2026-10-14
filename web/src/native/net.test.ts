import { afterEach, describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import {
  base64ToBytes, HttpStatusError, httpGetBase64, httpGetJson, NativeUnavailableError, netHttp, netResolve, netSpeed, netTcp, netWhois,
  type NetCallFn,
} from './net'

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as NetCallFn & typeof fn
}

/** 构造一个最小 HTTP 响应 */
function resp(over: Record<string, unknown> = {}) {
  return { status: 200, statusText: 'OK', url: 'https://a.com/', redirects: [], headers: {}, body: '', bodyEncoding: 'text', truncated: false, elapsedMs: 5, ...over }
}

afterEach(() => vi.unstubAllGlobals())

describe('无宿主', () => {
  it('默认 call 且没有宿主：全部抛 NativeUnavailableError', () => {
    expect(() => netHttp({ url: 'https://a.com' })).toThrow(NativeUnavailableError)
    expect(() => netResolve('a.com')).toThrow(NativeUnavailableError)
    expect(() => netTcp('1.1.1.1', 443)).toThrow(NativeUnavailableError)
    expect(() => netWhois('a.com')).toThrow(NativeUnavailableError)
    expect(() => netSpeed({ url: 'https://a.com' })).toThrow(NativeUnavailableError)
  })
})

describe('netHttp', () => {
  it('透传参数与取消信号', async () => {
    const call = fakeCall(resp())
    const ac = new AbortController()
    const r = await netHttp({ url: 'https://a.com', followRedirects: false }, call, ac.signal)
    expect(r.status).toBe(200)
    const [method, params, opts] = call.mock.calls[0] as unknown as [string, Record<string, unknown>, { signal: AbortSignal; timeoutMs: number }]
    expect(method).toBe('native.net.http')
    expect(params).toEqual({ url: 'https://a.com', followRedirects: false })
    expect(opts.signal).toBe(ac.signal)
    expect(opts.timeoutMs).toBeGreaterThan(10_000)
  })
})

describe('netResolve / netTcp / netWhois / netSpeed', () => {
  it('resolve 传 host', async () => {
    const call = fakeCall({ addresses: [{ ip: '1.2.3.4', family: 4 }], elapsedMs: 3 })
    expect((await netResolve('a.com', call)).addresses[0].ip).toBe('1.2.3.4')
    expect(call).toHaveBeenCalledWith('native.net.resolve', { host: 'a.com' }, expect.anything())
  })
  it('tcp 带默认超时 5000', async () => {
    const call = fakeCall({ ok: true, elapsedMs: 12 })
    expect((await netTcp('1.1.1.1', 443, undefined, call)).ok).toBe(true)
    expect(call).toHaveBeenCalledWith('native.net.tcp', { host: '1.1.1.1', port: 443, timeoutMs: 5000 }, expect.anything())
  })
  it('whois 有 server 才带上', async () => {
    const call = fakeCall({ server: 'whois.x', text: 't', truncated: false })
    await netWhois('a.com', undefined, call)
    expect(call).toHaveBeenLastCalledWith('native.net.whois', { query: 'a.com' }, expect.anything())
    await netWhois('a.com', 'whois.y', call)
    expect(call).toHaveBeenLastCalledWith('native.net.whois', { query: 'a.com', server: 'whois.y' }, expect.anything())
  })
  it('speed 透传并把桥超时放宽到时长之上', async () => {
    const call = fakeCall({ bytes: 1, elapsedMs: 1, bps: 8 })
    await netSpeed({ url: 'https://a.com', durationMs: 8000 }, call)
    const opts = (call.mock.calls[0] as unknown as [string, unknown, { timeoutMs: number }])[2]
    expect(opts.timeoutMs).toBeGreaterThan(8000)
  })
})

describe('httpGetJson', () => {
  it('2xx 解析 JSON，并带 accept 头', async () => {
    const call = fakeCall(resp({ body: '{"a":1}' }))
    expect(await httpGetJson<{ a: number }>('https://a.com/j', call)).toEqual({ a: 1 })
    const params = (call.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1]
    expect(params.headers.accept).toBe('application/json')
  })
  it('非 2xx 抛带 status 的错误', async () => {
    const err = (await httpGetJson('https://a.com/j', fakeCall(resp({ status: 404 }))).catch((e) => e)) as HttpStatusError
    expect(err).toBeInstanceOf(HttpStatusError)
    expect(err.status).toBe(404)
  })
  it('正文不是 JSON 抛 SyntaxError', async () => {
    await expect(httpGetJson('https://a.com/j', fakeCall(resp({ body: '<html>' })))).rejects.toBeInstanceOf(SyntaxError)
  })
})

describe('base64ToBytes / httpGetBase64', () => {
  it('base64 解码成字节', () => {
    expect(Array.from(base64ToBytes('aGk='))).toEqual([104, 105])
    expect(base64ToBytes('').length).toBe(0)
  })
  it('返回 Blob 与 content-type（去掉参数）', async () => {
    const call = fakeCall(resp({ body: 'aGk=', bodyEncoding: 'base64', headers: { 'content-type': 'image/jpeg; charset=x' } }))
    const { blob, contentType } = await httpGetBase64('https://a.com/a.jpg', call)
    expect(blob.size).toBe(2)
    expect(blob.type).toBe('image/jpeg')
    expect(contentType).toBe('image/jpeg; charset=x')
    expect((call.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].responseType).toBe('base64')
  })
  it('非 2xx / 截断都抛错', async () => {
    await expect(httpGetBase64('https://a.com/x', fakeCall(resp({ status: 500 })))).rejects.toBeInstanceOf(HttpStatusError)
    await expect(httpGetBase64('https://a.com/x', fakeCall(resp({ truncated: true })))).rejects.toThrow('2MB')
  })
})
