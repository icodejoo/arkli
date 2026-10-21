import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { oneOf } from '@/shared/persistValidators'
import { MODE_VALUES, ENC_VALUES, STORE_NS } from './logic'

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

describe('rc4 持久缓存', () => {
  it('读缓存回填', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_mode`]: '"decrypt"',
      [`${STORE_NS}_enc`]: '"hex"',
    }))
    expect(usePersistedRef(store, 'mode', 'encrypt', oneOf(MODE_VALUES)).value).toEqual('decrypt')
    expect(usePersistedRef(store, 'enc', 'base64', oneOf(ENC_VALUES)).value).toEqual('hex')
  })
  it('非法缓存回落默认', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_mode`]: '"x"',
      [`${STORE_NS}_enc`]: '"rot13"',
    }))
    expect(usePersistedRef(store, 'mode', 'encrypt', oneOf(MODE_VALUES)).value).toEqual('encrypt')
    expect(usePersistedRef(store, 'enc', 'base64', oneOf(ENC_VALUES)).value).toEqual('base64')
  })
})
