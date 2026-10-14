import { describe, expect, it } from 'vitest'
import { checkLabel, checkUrl, makeShortcutId, MAX_LABEL, suggestLabel } from './logic'

describe('checkUrl', () => {
  it('补全 https 并规范化', () => {
    expect(checkUrl('zhihu.com')).toEqual({ ok: true, url: 'https://zhihu.com/' })
    expect(checkUrl('  https://www.zhihu.com/a?b=1 ')).toEqual({ ok: true, url: 'https://www.zhihu.com/a?b=1' })
    expect(checkUrl('http://example.cn/x')).toEqual({ ok: true, url: 'http://example.cn/x' })
  })
  it('带端口的主机不会被当成协议', () => {
    expect(checkUrl('localhost:8080')).toEqual({ ok: true, url: 'https://localhost:8080/' })
    expect(checkUrl('192.168.1.2:3000/a')).toEqual({ ok: true, url: 'https://192.168.1.2:3000/a' })
  })
  it('拒绝其它协议', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://a.com', 'tel:10086', 'data:text/html,hi', 'intent://x#Intent;end']) {
      const r = checkUrl(bad)
      expect(r.ok, bad).toBe(false)
    }
  })
  it('空与乱写', () => {
    expect(checkUrl('')).toEqual({ ok: false, error: '先填网址' })
    expect(checkUrl('   ')).toEqual({ ok: false, error: '先填网址' })
    expect(checkUrl('not a url').ok).toBe(false)
    expect(checkUrl('https://').ok).toBe(false)
    expect(checkUrl('abc').ok).toBe(false)
  })
})

describe('checkLabel', () => {
  it('1~24 字', () => {
    expect(checkLabel('知乎')).toBeNull()
    expect(checkLabel(' x ')).toBeNull()
    expect(checkLabel('a'.repeat(MAX_LABEL))).toBeNull()
    expect(checkLabel('')).toMatch(/名字/)
    expect(checkLabel('   ')).toMatch(/名字/)
    expect(checkLabel('a'.repeat(MAX_LABEL + 1))).toMatch(/最多/)
  })
})

describe('suggestLabel', () => {
  it('取主机名第一段，去掉 www', () => {
    expect(suggestLabel('https://www.zhihu.com/')).toBe('zhihu')
    expect(suggestLabel('https://m.bilibili.com/x')).toBe('m')
    expect(suggestLabel('http://localhost:3000')).toBe('localhost')
    expect(suggestLabel('bad')).toBe('')
  })
})

describe('makeShortcutId', () => {
  it('同网址同 id，不同网址不同 id，长度合规', () => {
    const a = makeShortcutId('https://a.com/')
    expect(makeShortcutId('https://a.com/')).toBe(a)
    expect(makeShortcutId('https://b.com/')).not.toBe(a)
    expect(a).toMatch(/^web-[0-9a-f]{8}$/)
  })
})
