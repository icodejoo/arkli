import { describe, expect, it } from 'vitest'
import { BATCH_MAX, generateIds, nanoid, uuidV4, uuidV7, validateOptions, type GenOptions } from './logic'

/** 固定随机源：按计数器填充 */
const fixed = (buf: Uint8Array): Uint8Array => {
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 37 + 11) & 0xff
  return buf
}
const base: GenOptions = { kind: 'uuid4', count: 3, size: 21, alphabet: 'abc123', upper: false, noDash: false }

describe('uuid', () => {
  it('v4 格式、版本与变体位', () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('v7 前 48 位是时间戳', () => {
    const id = uuidV7(0x018c0000abcd, fixed)
    expect(id.replace(/-/g, '').slice(0, 12)).toBe('018c0000abcd')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('v7 随时间递增', () => {
    expect(uuidV7(1000) < uuidV7(2000)).toBe(true)
  })
  it('批量不重复', () => {
    expect(new Set(generateIds({ ...base, count: 200 })).size).toBe(200)
  })
  it('去连字符与大写', () => {
    const [id] = generateIds({ ...base, count: 1, noDash: true, upper: true })
    expect(id).toMatch(/^[0-9A-F]{32}$/)
  })
})

describe('nanoid', () => {
  it('长度与字符集', () => {
    const s = nanoid(50, 'abc123')
    expect(s).toHaveLength(50)
    expect(s).toMatch(/^[abc123]+$/)
  })
  it('默认长度 21', () => {
    expect(nanoid(21)).toHaveLength(21)
  })
  it('分布大致均匀（非 2 的幂字符集无明显偏差）', () => {
    const s = nanoid(6000, 'abc')
    for (const c of 'abc') expect(s.split(c).length - 1).toBeGreaterThan(1700)
  })
  it('字符集去重', () => {
    expect(nanoid(20, 'aabb')).toMatch(/^[ab]{20}$/)
  })
})

describe('validateOptions', () => {
  it('合法', () => expect(validateOptions(base)).toBe(''))
  it('数量越界', () => {
    expect(validateOptions({ ...base, count: 0 })).toContain('数量')
    expect(validateOptions({ ...base, count: BATCH_MAX + 1 })).toContain('数量')
  })
  it('nanoid 长度与字符集', () => {
    expect(validateOptions({ ...base, kind: 'nanoid', size: 0 })).toContain('长度')
    expect(validateOptions({ ...base, kind: 'nanoid', alphabet: 'aaa' })).toContain('字符集')
  })
})
