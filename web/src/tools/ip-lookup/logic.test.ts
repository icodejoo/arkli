import { describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import type { NetCallFn } from '@/native/net'
import { classifyInput, isIPv4, isIPv6, lookupIp, lookupMyIp, parseIpinfo, parseRdapIp, pickAddress } from './logic'

/** ipinfo 固定样例（带城市和经纬度，用来确认不被取走） */
const IPINFO = { ip: '1.1.1.1', hostname: 'one.one.one.one', city: 'Los Angeles', region: 'California', country: 'US', loc: '34.05,-118.24', org: 'AS13335 Cloudflare, Inc.', timezone: 'America/Los_Angeles' }

/** RDAP 固定样例 */
const RDAP = {
  handle: '1.0.0.0 - 1.0.0.255',
  startAddress: '1.0.0.0',
  endAddress: '1.0.0.255',
  name: 'APNIC-LABS',
  country: 'AU',
  cidr0_cidrs: [{ v4prefix: '1.0.0.0', length: 24 }],
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

describe('isIPv4 / isIPv6', () => {
  it('IPv4', () => {
    expect(['0.0.0.0', '8.8.8.8', '255.255.255.255'].every(isIPv4)).toBe(true)
    expect(['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', 'a.b.c.d', ''].some(isIPv4)).toBe(false)
  })
  it('IPv6', () => {
    for (const ok of ['::', '::1', '2001:db8::1', '1:2:3:4:5:6:7:8', 'fe80::1', '::ffff:1.2.3.4', '1:2:3:4:5:6:1.2.3.4', '1::']) {
      expect(isIPv6(ok), ok).toBe(true)
    }
    for (const bad of ['1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1::2::3', '12345::1', 'g::1', '1.2.3.4', '::1.2.3', ':1:2', '1:2:3:4:5:6:7::8', '']) {
      expect(isIPv6(bad), bad).toBe(false)
    }
  })
})

describe('classifyInput', () => {
  it('IP 与域名与无效', () => {
    expect(classifyInput(' 8.8.8.8 ')).toEqual({ kind: 'ipv4', value: '8.8.8.8' })
    expect(classifyInput('[2001:DB8::1]')).toEqual({ kind: 'ipv6', value: '2001:db8::1' })
    expect(classifyInput('fe80::1%eth0')).toEqual({ kind: 'ipv6', value: 'fe80::1' })
    expect(classifyInput('https://Example.com/x')).toEqual({ kind: 'domain', value: 'example.com' })
    expect(classifyInput('hello').kind).toBe('invalid')
    expect(classifyInput('999.1.1.1').kind).toBe('invalid')
  })
})

describe('pickAddress', () => {
  it('优先 IPv4，没有就取第一个，空为 null', () => {
    expect(pickAddress([{ ip: '::1', family: 6 }, { ip: '1.1.1.1', family: 4 }])).toBe('1.1.1.1')
    expect(pickAddress([{ ip: '::1', family: 6 }])).toBe('::1')
    expect(pickAddress([])).toBeNull()
  })
})

describe('parseIpinfo', () => {
  it('只取国家、ASN、组织、主机名，不含城市与经纬度', () => {
    const info = parseIpinfo(IPINFO)!
    expect(info).toMatchObject({ source: 'ipinfo', ip: '1.1.1.1', country: 'US', asn: 'AS13335', org: 'Cloudflare, Inc.', hostname: 'one.one.one.one' })
    const text = JSON.stringify(info)
    expect(text).not.toContain('Los Angeles')
    expect(text).not.toContain('34.05')
  })
  it('org 没有 ASN 前缀时整体当组织名', () => {
    expect(parseIpinfo({ ip: '1.2.3.4', org: 'Some ISP' })).toMatchObject({ asn: null, org: 'Some ISP' })
  })
  it('bogon、错误响应、缺 ip 返回 null', () => {
    expect(parseIpinfo({ ip: '10.0.0.1', bogon: true })).toBeNull()
    expect(parseIpinfo({ status: 429, error: { title: 'x' } })).toBeNull()
    expect(parseIpinfo({})).toBeNull()
    expect(parseIpinfo(null)).toBeNull()
  })
})

describe('parseRdapIp', () => {
  it('解析名称、国家、句柄、范围与 CIDR', () => {
    expect(parseRdapIp(RDAP, '1.0.0.1')).toMatchObject({
      source: 'rdap', ip: '1.0.0.1', name: 'APNIC-LABS', country: 'AU', handle: '1.0.0.0 - 1.0.0.255',
      range: '1.0.0.0 - 1.0.0.255', cidrs: ['1.0.0.0/24'],
    })
  })
  it('IPv6 前缀', () => {
    expect(parseRdapIp({ name: 'X', cidr0_cidrs: [{ v6prefix: '2001:db8::', length: 32 }] }, '2001:db8::1')?.cidrs).toEqual(['2001:db8::/32'])
  })
  it('什么都没有返回 null', () => {
    expect(parseRdapIp({ errorCode: 404 }, '1.1.1.1')).toBeNull()
    expect(parseRdapIp('x', '1.1.1.1')).toBeNull()
  })
})

describe('lookupIp', () => {
  it('ipinfo 成功就不查 RDAP', async () => {
    const call = seq(http(200, IPINFO))
    expect((await lookupIp('1.1.1.1', call)).source).toBe('ipinfo')
    expect(call).toHaveBeenCalledTimes(1)
    expect((call.mock.calls[0] as unknown as [string, { url: string }])[1].url).toBe('https://ipinfo.io/1.1.1.1/json')
  })
  it('ipinfo 失败（限流 / 网络）回退 RDAP', async () => {
    const r1 = await lookupIp('1.0.0.1', seq(http(429, {}), http(200, RDAP)))
    expect(r1.source).toBe('rdap')
    const r2 = await lookupIp('1.0.0.1', seq(new Error('x'), http(200, RDAP)))
    expect(r2.source).toBe('rdap')
    const r3 = await lookupIp('10.0.0.1', seq(http(200, { ip: '10.0.0.1', bogon: true }), http(200, RDAP)))
    expect(r3.source).toBe('rdap')
  })
  it('两边都不行就抛错', async () => {
    await expect(lookupIp('1.1.1.1', seq(new Error('x'), http(200, {})))).rejects.toThrow('没有查到')
    await expect(lookupIp('1.1.1.1', seq(new Error('x'), http(404, {})))).rejects.toThrow('404')
  })
  it('已取消不再回退', async () => {
    const ac = new AbortController()
    ac.abort()
    const call = seq(new Error('cancelled'), http(200, RDAP))
    await expect(lookupIp('1.1.1.1', call, ac.signal)).rejects.toThrow('cancelled')
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('lookupMyIp', () => {
  it('ipinfo 自查成功', async () => {
    expect((await lookupMyIp(seq(http(200, IPINFO)))).ip).toBe('1.1.1.1')
  })
  it('ipinfo 失败：用 ipify 拿 IP 再查', async () => {
    const call = seq(http(429, {}), http(200, { ip: '1.0.0.1' }), http(200, IPINFO))
    const r = await lookupMyIp(call)
    expect(r.source).toBe('ipinfo')
    expect(call).toHaveBeenCalledTimes(3)
  })
  it('ipify 给了假 IP 抛错', async () => {
    await expect(lookupMyIp(seq(http(500, {}), http(200, { ip: 'oops' })))).rejects.toThrow('本机公网 IP')
  })
})
