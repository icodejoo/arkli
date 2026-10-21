import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { oneOf, isBool } from '@/shared/persistValidators'
import { DIAL_VALUES, TILT_KIND_VALUES, STORE_NS } from './logic'

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

describe('protractor 持久缓存', () => {
  it('读缓存回填', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_dial`]: '"full"',
      [`${STORE_NS}_tiltKind`]: '"surface"',
      [`${STORE_NS}_snap`]: 'true',
    }))
    expect(usePersistedRef(store, 'dial', 'half', oneOf(DIAL_VALUES)).value).toEqual('full')
    expect(usePersistedRef(store, 'tiltKind', 'edge', oneOf(TILT_KIND_VALUES)).value).toEqual('surface')
    expect(usePersistedRef(store, 'snap', false, isBool).value).toEqual(true)
  })
  it('非法缓存回落默认', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_dial`]: '"x"',
      [`${STORE_NS}_tiltKind`]: '"x"',
      [`${STORE_NS}_snap`]: '"x"',
    }))
    expect(usePersistedRef(store, 'dial', 'half', oneOf(DIAL_VALUES)).value).toEqual('half')
    expect(usePersistedRef(store, 'tiltKind', 'edge', oneOf(TILT_KIND_VALUES)).value).toEqual('edge')
    expect(usePersistedRef(store, 'snap', false, isBool).value).toEqual(false)
  })
})
