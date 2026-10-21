import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { inRange } from '@/shared/persistValidators'
import { DEFAULT_OPTIONS, MAX_COUNT, MIN_COUNT, sanitizeOptions, STORE_NS } from './logic'

/** 内存存储后端 */
function memory(init: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(init))
  return {
    get length() {
      return map.size
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('password-gen 持久缓存', () => {
  it('sanitizeOptions：合法值保留，缺项补默认', () => {
    const o = sanitizeOptions({ length: 32, sets: { symbols: true }, ensureEach: false })
    expect(o.length).toBe(32)
    expect(o.sets).toEqual({ ...DEFAULT_OPTIONS.sets, symbols: true })
    expect(o.ensureEach).toBe(false)
    expect(o.excludeAmbiguous).toBe(DEFAULT_OPTIONS.excludeAmbiguous)
  })
  it('sanitizeOptions：非法缓存回落默认', () => {
    expect(sanitizeOptions(null)).toEqual(DEFAULT_OPTIONS)
    expect(sanitizeOptions({ length: 9999, sets: 'x', ensureEach: 1 })).toEqual(DEFAULT_OPTIONS)
    expect(sanitizeOptions({ sets: { upper: 'no' } }).sets.upper).toBe(DEFAULT_OPTIONS.sets.upper)
  })
  it('个数：读缓存回填，非法回落', () => {
    const range = { min: MIN_COUNT, max: MAX_COUNT }
    const ok = createToolStorage(STORE_NS, memory({ [`${STORE_NS}_count`]: '5' }))
    expect(usePersistedRef(ok, 'count', 1, (x) => inRange(x, range)).value).toBe(5)
    const bad = createToolStorage(STORE_NS, memory({ [`${STORE_NS}_count`]: '500' }))
    expect(usePersistedRef(bad, 'count', 1, (x) => inRange(x, range)).value).toBe(1)
  })
})
