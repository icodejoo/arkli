import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { inRange, isBool } from '@/shared/persistValidators'
import { MAX_COUNT, MAX_DECIMALS, STORE_NS } from './logic'

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

describe('random-number 持久缓存', () => {
  it('读缓存回填', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_count`]: '20',
      [`${STORE_NS}_decimals`]: '3',
      [`${STORE_NS}_allowDuplicates`]: 'false',
      [`${STORE_NS}_sort`]: 'true',
    }))
    expect(usePersistedRef(store, 'count', 5, (x: number) => inRange(x, { min: 1, max: MAX_COUNT })).value).toEqual(20)
    expect(usePersistedRef(store, 'decimals', 0, (x: number) => inRange(x, { min: 0, max: MAX_DECIMALS })).value).toEqual(3)
    expect(usePersistedRef(store, 'allowDuplicates', true, isBool).value).toEqual(false)
    expect(usePersistedRef(store, 'sort', false, isBool).value).toEqual(true)
  })
  it('非法缓存回落默认', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_count`]: '5000',
      [`${STORE_NS}_decimals`]: '99',
      [`${STORE_NS}_allowDuplicates`]: '"x"',
      [`${STORE_NS}_sort`]: '7',
    }))
    expect(usePersistedRef(store, 'count', 5, (x: number) => inRange(x, { min: 1, max: MAX_COUNT })).value).toEqual(5)
    expect(usePersistedRef(store, 'decimals', 0, (x: number) => inRange(x, { min: 0, max: MAX_DECIMALS })).value).toEqual(0)
    expect(usePersistedRef(store, 'allowDuplicates', true, isBool).value).toEqual(true)
    expect(usePersistedRef(store, 'sort', false, isBool).value).toEqual(false)
  })
})
