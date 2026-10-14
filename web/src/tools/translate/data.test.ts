import { describe, expect, it } from 'vitest'
import { TEXT_MAX, WEB_ENTRIES } from './data'

describe('WEB_ENTRIES', () => {
  it('全是 https 且无查询串与锚点', () => {
    for (const e of WEB_ENTRIES) {
      const u = new URL(e.url)
      expect(u.protocol).toBe('https:')
      expect(u.search).toBe('')
      expect(u.hash).toBe('')
    }
  })
  it('名称与地址不重复', () => {
    expect(new Set(WEB_ENTRIES.map((e) => e.name)).size).toBe(WEB_ENTRIES.length)
    expect(new Set(WEB_ENTRIES.map((e) => e.url)).size).toBe(WEB_ENTRIES.length)
  })
  it('长度上限为 5000', () => {
    expect(TEXT_MAX).toBe(5000)
  })
})
