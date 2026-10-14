import { describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import type { NetCallFn } from '@/native/net'
import { formatRdapDate, normalizeDomain, parseRdapDomain, queryDomain } from './logic'

/** RDAP 固定样例 */
const SAMPLE = {
  ldhName: 'EXAMPLE.COM',
  status: ['client delete prohibited', 'active'],
  events: [
    { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
    { eventAction: 'expiration', eventDate: '2026-08-13T04:00:00Z' },
    { eventAction: 'last changed', eventDate: '2025-08-14T07:01:34Z' },
    { eventAction: 'last update of RDAP database', eventDate: '2026-10-13T00:00:00Z' },
  ],
  nameservers: [{ ldhName: 'A.IANA-SERVERS.NET' }, { ldhName: 'b.iana-servers.net' }],
  entities: [
    { roles: ['abuse'], vcardArray: ['vcard', [['fn', {}, 'text', 'Abuse']]] },
    { roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'RESERVED-Internet Assigned Numbers Authority']]] },
  ],
}

/** 按顺序返回结果或抛错的假 call */
function seq(...steps: Array<unknown | Error>) {
  const fn = vi.fn(async () => {
    const s = steps.shift()
    if (s instanceof Error) throw s
    return s
  })
  return fn as unknown as NetCallFn & typeof fn
}

/** 构造 HTTP 响应 */
function http(status: number, body: unknown) {
  return { status, statusText: '', url: '', redirects: [], headers: {}, body: JSON.stringify(body), bodyEncoding: 'text', truncated: false, elapsedMs: 1 }
}

describe('normalizeDomain', () => {
  it('去协议、账号、路径、端口并转小写', () => {
    expect(normalizeDomain('https://User@WWW.Example.com:8080/a?b#c')).toBe('www.example.com')
    expect(normalizeDomain(' Example.COM. ')).toBe('example.com')
    expect(normalizeDomain('example.co.uk/path')).toBe('example.co.uk')
  })
  it('punycode 原样保留，不转换', () => {
    expect(normalizeDomain('xn--fiq228c.com')).toBe('xn--fiq228c.com')
    expect(normalizeDomain('中文.com')).toBeNull()
  })
  it('非法输入返回 null', () => {
    for (const bad of ['', 'localhost', 'a..com', '-a.com', 'a-.com', 'a.c', 'a.123', 'exa mple.com', 'a_b.com']) {
      expect(normalizeDomain(bad), bad).toBeNull()
    }
    expect(normalizeDomain('a'.repeat(64) + '.com')).toBeNull()
  })
})

describe('parseRdapDomain', () => {
  it('解析注册商、三类时间、状态、DNS', () => {
    expect(parseRdapDomain(SAMPLE)).toEqual({
      domain: 'example.com',
      registrar: 'RESERVED-Internet Assigned Numbers Authority',
      registered: '1995-08-14T04:00:00Z',
      expires: '2026-08-13T04:00:00Z',
      updated: '2025-08-14T07:01:34Z',
      status: ['client delete prohibited', 'active'],
      nameservers: ['a.iana-servers.net', 'b.iana-servers.net'],
    })
  })
  it('缺字段给 null / 空数组', () => {
    expect(parseRdapDomain({ ldhName: 'a.com' })).toEqual({ domain: 'a.com', registrar: null, registered: null, expires: null, updated: null, status: [], nameservers: [] })
  })
  it('不像域名响应返回 null', () => {
    expect(parseRdapDomain(null)).toBeNull()
    expect(parseRdapDomain({ errorCode: 404 })).toBeNull()
    expect(parseRdapDomain('x')).toBeNull()
  })
})

describe('formatRdapDate', () => {
  it('按 UTC 显示', () => {
    expect(formatRdapDate('2024-03-05T08:09:00Z')).toBe('2024-03-05 08:09 (UTC)')
    expect(formatRdapDate('2024-03-05T08:09:00+08:00')).toBe('2024-03-05 00:09 (UTC)')
  })
  it('解析不了原样返回', () => {
    expect(formatRdapDate('不是日期')).toBe('不是日期')
  })
})

describe('queryDomain', () => {
  it('RDAP 成功：只请求一次', async () => {
    const call = seq(http(200, SAMPLE))
    const r = await queryDomain('example.com', call)
    expect(r.kind).toBe('rdap')
    expect(call).toHaveBeenCalledTimes(1)
    expect((call.mock.calls[0] as unknown as [string, { url: string }])[1].url).toBe('https://rdap.org/domain/example.com')
  })
  it('RDAP 404：回退 Whois 原文', async () => {
    const call = seq(http(404, {}), { server: 'whois.x', text: 'raw', truncated: true })
    expect(await queryDomain('example.com', call)).toEqual({ kind: 'whois', server: 'whois.x', text: 'raw', truncated: true })
    expect((call.mock.calls[1] as unknown as [string])[0]).toBe('native.net.whois')
  })
  it('RDAP 网络失败或解析不出：回退 Whois', async () => {
    const r1 = await queryDomain('a.com', seq(new Error('x'), { server: 's', text: 't', truncated: false }))
    expect(r1.kind).toBe('whois')
    const r2 = await queryDomain('a.com', seq(http(200, { foo: 1 }), { server: 's', text: 't', truncated: false }))
    expect(r2.kind).toBe('whois')
  })
  it('两条路都失败：抛 Whois 的错误', async () => {
    await expect(queryDomain('a.com', seq(new Error('r'), new Error('w')))).rejects.toThrow('w')
  })
  it('已取消：不再兜底', async () => {
    const ac = new AbortController()
    ac.abort()
    const call = seq(new Error('cancelled'), { server: 's', text: 't', truncated: false })
    await expect(queryDomain('a.com', call, ac.signal)).rejects.toThrow('cancelled')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
