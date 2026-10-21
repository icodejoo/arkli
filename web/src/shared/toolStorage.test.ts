import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from './toolStorage'

/** 内存存储，模拟 localStorage */
function memory(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('createToolStorage', () => {
  it('键为 ns_key，值为 JSON 字符串', () => {
    const m = memory()
    const x = createToolStorage('yyy', m)
    expect(x.set('zzz', 1)).toBe(true)
    expect(m.map.get('yyy_zzz')).toBe('1')
    x.set('obj', { a: [1, 'b'] })
    expect(x.get('obj', null)).toEqual({ a: [1, 'b'] })
  })

  it('不存在或解析失败返回 fallback', () => {
    const m = memory()
    const x = createToolStorage('t', m)
    expect(x.get('none', 7)).toBe(7)
    m.map.set('t_bad', '{oops')
    expect(x.get('bad', 'd')).toBe('d')
  })

  it('has / remove / keys / clear 只作用于本命名空间', () => {
    const m = memory()
    const a = createToolStorage('a', m)
    const b = createToolStorage('b', m)
    a.set('k1', 1)
    a.set('k2', 2)
    b.set('k1', 9)
    expect(a.has('k1')).toBe(true)
    expect(a.keys().sort()).toEqual(['k1', 'k2'])
    a.remove('k1')
    expect(a.has('k1')).toBe(false)
    a.clear()
    expect(a.keys()).toEqual([])
    expect(b.get('k1', 0)).toBe(9)
  })

  it('不可序列化的值写入失败；后端为 null 时静默降级', () => {
    const x = createToolStorage('t', memory())
    expect(x.set('u', undefined)).toBe(false)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(x.set('c', circular)).toBe(false)
    const n = createToolStorage('t', null)
    expect(n.set('a', 1)).toBe(false)
    expect(n.get('a', 5)).toBe(5)
    expect(n.keys()).toEqual([])
  })

  it('写入抛错（如空间不足）时返回 false', () => {
    const m = memory()
    m.setItem = () => {
      throw new Error('quota')
    }
    expect(createToolStorage('t', m).set('a', 1)).toBe(false)
  })

  it('ns 为空抛错', () => {
    expect(() => createToolStorage('')).toThrow()
  })

  it('adoptLegacy 只迁一次并删掉旧键', () => {
    const m = memory()
    m.map.set('old.k', '[1,2]')
    const x = createToolStorage('t', m)
    x.adoptLegacy('old.k', 'k')
    expect(x.get('k', [])).toEqual([1, 2])
    expect(m.map.has('old.k')).toBe(false)
    m.map.set('old.k', '[9]')
    x.adoptLegacy('old.k', 'k')
    expect(x.get('k', [])).toEqual([1, 2])
  })

  it('adoptLegacy 非 JSON 旧值按原字符串存', () => {
    const m = memory()
    m.map.set('old', 'dark')
    const x = createToolStorage('t', m)
    x.adoptLegacy('old', 'mode')
    expect(x.get('mode', '')).toBe('dark')
  })
})
