import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { isBool, oneOf } from '@/shared/persistValidators'
import { LEVELS, STORE_NS } from './logic'

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

describe('minesweeper 持久缓存', () => {
  it('读缓存回填', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_flagMode`]: 'true',
      [`${STORE_NS}_level`]: '"hard"',
    }))
    expect(usePersistedRef(store, 'flagMode', false, isBool).value).toEqual(true)
    expect(usePersistedRef(store, 'level', 'easy', oneOf(LEVELS.map((l) => l.id))).value).toEqual('hard')
  })
  it('非法缓存回落默认', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_flagMode`]: '"x"',
      [`${STORE_NS}_level`]: '"zzz"',
    }))
    expect(usePersistedRef(store, 'flagMode', false, isBool).value).toEqual(false)
    expect(usePersistedRef(store, 'level', 'easy', oneOf(LEVELS.map((l) => l.id))).value).toEqual('easy')
  })
})
