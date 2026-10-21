import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createToolStorage, type StorageLike } from './toolStorage'
import { usePersistedRef } from './usePersistedRef'

/** 内存存储 */
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

describe('usePersistedRef', () => {
  it('没有缓存时用默认值，变化后写回', async () => {
    const m = memory()
    const r = usePersistedRef(createToolStorage('t', m), 'k', 'a')
    expect(r.value).toBe('a')
    r.value = 'b'
    await nextTick()
    expect(m.map.get('t_k')).toBe('"b"')
  })

  it('有缓存时读缓存', () => {
    const m = memory()
    m.map.set('t_k', '3')
    expect(usePersistedRef(createToolStorage('t', m), 'k', 0).value).toBe(3)
  })

  it('校验不通过回落默认值', () => {
    const m = memory()
    m.map.set('t_k', '"gone"')
    expect(usePersistedRef(createToolStorage('t', m), 'k', 'a', (v) => v === 'a' || v === 'b').value).toBe('a')
  })

  it('对象/数组深层修改也会写回', async () => {
    const m = memory()
    const r = usePersistedRef(createToolStorage('t', m), 'k', { n: 1 })
    r.value.n = 2
    await nextTick()
    expect(m.map.get('t_k')).toBe('{"n":2}')
  })
})
