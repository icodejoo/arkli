import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { oneOf, inRange } from '@/shared/persistValidators'
import { MODE_VALUES, WPM_MIN, WPM_MAX, FREQ_MIN, FREQ_MAX, STORE_NS } from './logic'

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

describe('morse 持久缓存', () => {
  it('读缓存回填', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_mode`]: '"decode"',
      [`${STORE_NS}_wpm`]: '25',
      [`${STORE_NS}_freq`]: '800',
    }))
    expect(usePersistedRef(store, 'mode', 'encode', oneOf(MODE_VALUES)).value).toEqual('decode')
    expect(usePersistedRef(store, 'wpm', 15, (x: number) => inRange(x, { min: WPM_MIN, max: WPM_MAX })).value).toEqual(25)
    expect(usePersistedRef(store, 'freq', 600, (x: number) => inRange(x, { min: FREQ_MIN, max: FREQ_MAX })).value).toEqual(800)
  })
  it('非法缓存回落默认', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_mode`]: '"x"',
      [`${STORE_NS}_wpm`]: '999',
      [`${STORE_NS}_freq`]: '5',
    }))
    expect(usePersistedRef(store, 'mode', 'encode', oneOf(MODE_VALUES)).value).toEqual('encode')
    expect(usePersistedRef(store, 'wpm', 15, (x: number) => inRange(x, { min: WPM_MIN, max: WPM_MAX })).value).toEqual(15)
    expect(usePersistedRef(store, 'freq', 600, (x: number) => inRange(x, { min: FREQ_MIN, max: FREQ_MAX })).value).toEqual(600)
  })
})
