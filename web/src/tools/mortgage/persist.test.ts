import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { oneOf } from '@/shared/persistValidators'
import { KIND_VALUES, METHOD_VALUES, STORE_NS } from './logic'

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

describe('mortgage 持久缓存', () => {
  it('读缓存回填', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_kind`]: '"combo"',
      [`${STORE_NS}_method`]: '"equal-principal"',
    }))
    expect(usePersistedRef(store, 'kind', 'biz', oneOf(KIND_VALUES)).value).toEqual('combo')
    expect(usePersistedRef(store, 'method', 'equal-payment', oneOf(METHOD_VALUES)).value).toEqual('equal-principal')
  })
  it('非法缓存回落默认', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_kind`]: '"x"',
      [`${STORE_NS}_method`]: '1',
    }))
    expect(usePersistedRef(store, 'kind', 'biz', oneOf(KIND_VALUES)).value).toEqual('biz')
    expect(usePersistedRef(store, 'method', 'equal-payment', oneOf(METHOD_VALUES)).value).toEqual('equal-payment')
  })
})
