import { describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import type { NetCallFn } from '@/native/net'
import { isRedirectStatus, MAX_HOPS, outcomeText, resolveLocation, traceRedirects } from './logic'

/** 站点表：url → [状态码, location]，没配的地址返回 404 */
function site(table: Record<string, [number, string?]>) {
  const fn = vi.fn(async (_m: string, p?: Record<string, unknown>) => {
    const url = (p as { url: string }).url
    if (url.includes('err.test')) throw { code: 'NETWORK', message: '连不上' }
    const [status, location] = table[url] ?? [404]
    return { status, statusText: '', url, redirects: [], headers: location ? { location } : {}, body: '', bodyEncoding: 'text', truncated: false, elapsedMs: 1 }
  })
  return fn as unknown as NetCallFn & typeof fn
}

describe('isRedirectStatus / resolveLocation', () => {
  it('跳转状态码', () => {
    expect([301, 302, 303, 307, 308].every(isRedirectStatus)).toBe(true)
    expect([200, 304, 404].some(isRedirectStatus)).toBe(false)
  })
  it('解析相对地址', () => {
    expect(resolveLocation('/b?x=1', 'https://a.com/x/y')).toBe('https://a.com/b?x=1')
    expect(resolveLocation('z', 'https://a.com/x/y')).toBe('https://a.com/x/z')
    expect(resolveLocation('//b.com/p', 'https://a.com/')).toBe('https://b.com/p')
    expect(resolveLocation('https://c.com', 'https://a.com/')).toBe('https://c.com/')
    expect(resolveLocation('http://', 'https://a.com/')).toBeNull()
  })
})

describe('traceRedirects', () => {
  it('正常链：每跳不跟随，记录状态与最终地址', async () => {
    const call = site({
      'https://t.cn/a': [301, 'https://m.com/x'],
      'https://m.com/x': [302, 'https://dest.com/'],
      'https://dest.com/': [200],
    })
    const seen: number[] = []
    const r = await traceRedirects('https://t.cn/a', call, { onHop: (h) => seen.push(h.status) })
    expect(r.outcome).toBe('done')
    expect(r.finalUrl).toBe('https://dest.com/')
    expect(r.hops.map((h) => [h.url, h.status])).toEqual([['https://t.cn/a', 301], ['https://m.com/x', 302], ['https://dest.com/', 200]])
    expect(seen).toEqual([301, 302, 200])
    expect((call.mock.calls[0][1] as Record<string, unknown>).followRedirects).toBe(false)
  })
  it('直接 200：只有一跳', async () => {
    const r = await traceRedirects('https://a.com/', site({ 'https://a.com/': [200] }))
    expect(r.hops.length).toBe(1)
    expect(r.outcome).toBe('done')
  })
  it('相对跳转按当前地址解析', async () => {
    const r = await traceRedirects('https://a.com/x/y', site({ 'https://a.com/x/y': [302, '../z'], 'https://a.com/z': [200] }))
    expect(r.finalUrl).toBe('https://a.com/z')
    expect(r.hops[0].location).toBe('https://a.com/z')
  })
  it('循环：回到走过的地址就停（hash 不算）', async () => {
    const r = await traceRedirects('https://a.com/', site({ 'https://a.com/': [302, 'https://b.com/'], 'https://b.com/': [302, 'https://a.com/#top'] }))
    expect(r.outcome).toBe('loop')
    expect(r.hops.length).toBe(2)
  })
  it('超限：跳满 10 跳仍在跳转', async () => {
    const table: Record<string, [number, string]> = {}
    for (let i = 0; i < 30; i++) table[`https://a.com/${i}`] = [302, `https://a.com/${i + 1}`]
    const call = site(table)
    const r = await traceRedirects('https://a.com/0', call)
    expect(r.outcome).toBe('too-many')
    expect(r.hops.length).toBe(MAX_HOPS)
    expect(call).toHaveBeenCalledTimes(MAX_HOPS)
    const r2 = await traceRedirects('https://a.com/0', site(table), { maxHops: 3 })
    expect(r2.hops.length).toBe(3)
  })
  it('跳转状态但无 location', async () => {
    const r = await traceRedirects('https://a.com/', site({ 'https://a.com/': [302] }))
    expect(r.outcome).toBe('no-location')
    expect(r.finalUrl).toBe('https://a.com/')
    expect(r.hops[0].location).toBeUndefined()
  })
  it('location 无法解析', async () => {
    const r = await traceRedirects('https://a.com/', site({ 'https://a.com/': [302, 'http://'] }))
    expect(r.outcome).toBe('bad-location')
  })
  it('指向 App 唤起链接：停下并给出目标', async () => {
    const r = await traceRedirects('https://a.com/', site({ 'https://a.com/': [302, 'bilibili://video/1'] }))
    expect(r.outcome).toBe('unsupported')
    expect(r.finalUrl).toBe('bilibili://video/1')
  })
  it('请求失败：不抛错，保留已走过的跳', async () => {
    const r = await traceRedirects('https://a.com/', site({ 'https://a.com/': [302, 'https://err.test/'] }))
    expect(r.outcome).toBe('error')
    expect(r.error).toBe('连不上')
    expect(r.hops.length).toBe(1)
    expect(r.finalUrl).toBe('https://err.test/')
  })
})

describe('outcomeText', () => {
  it('每种结果都有说明', () => {
    expect(outcomeText('done')).toContain('最终')
    expect(outcomeText('loop')).toContain('循环')
    expect(outcomeText('too-many')).toContain('过多')
  })
})
