import { describe, expect, it } from 'vitest'
import { base64urlDecode, formatLocal, parseJwt } from './logic'

/** 编码成 base64url */
const enc = (o: unknown): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const make = (payload: unknown): string => `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sigPart_-x`
const NOW = 1_700_000_000_000

describe('base64urlDecode', () => {
  it('无填充与 url 字符', () => {
    expect(base64urlDecode('aGk')).toBe('hi')
    expect(base64urlDecode(enc('中文?>'))).toBe('"中文?>"')
  })
  it('非法字符报错', () => {
    expect(() => base64urlDecode('a+b')).toThrow()
  })
})

describe('parseJwt', () => {
  it('解析 header / payload / 签名', () => {
    const r = parseJwt(make({ sub: '1', name: '张三' }), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.header).toEqual({ alg: 'HS256', typ: 'JWT' })
      expect(r.value.payload).toEqual({ sub: '1', name: '张三' })
      expect(r.value.signature).toBe('sigPart_-x')
      expect(r.value.expired).toBeNull()
    }
  })
  it('exp 已过期与未过期', () => {
    const a = parseJwt(make({ exp: NOW / 1000 - 10 }), NOW)
    const b = parseJwt(make({ exp: NOW / 1000 + 10 }), NOW)
    expect(a.ok && a.value.expired).toBe(true)
    expect(b.ok && b.value.expired).toBe(false)
  })
  it('识别 iat / nbf 并转本地时间', () => {
    const r = parseJwt(make({ iat: 1, nbf: NOW / 1000 + 5 }), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.times.map((x) => x.key)).toEqual(['iat', 'nbf'])
      expect(r.value.times[0].text).toBe(formatLocal(1))
      expect(r.value.notYet).toBe(true)
    }
  })
  it('允许 Bearer 前缀与换行', () => {
    expect(parseJwt('Bearer ' + make({}).replace('.', '\n.'), NOW).ok).toBe(true)
  })
  it('空输入与段数错误', () => {
    expect(parseJwt('  ')).toEqual({ ok: false, error: '请粘贴 JWT' })
    const r = parseJwt('a.b')
    expect(!r.ok && r.error).toContain('2 段')
  })
  it('Header / Payload 非法时指明哪一段', () => {
    const bad = parseJwt(`!!.${enc({})}.s`)
    expect(!bad.ok && bad.error).toContain('Header')
    const notJson = parseJwt(`${enc({})}.aGk.s`)
    expect(!notJson.ok && notJson.error).toContain('Payload')
    expect(!notJson.ok && notJson.error).toContain('JSON')
  })
})
