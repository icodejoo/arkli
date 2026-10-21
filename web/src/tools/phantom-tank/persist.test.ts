import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { oneOf, inRange } from '@/shared/persistValidators'
import { CONTRAST_MIN, CONTRAST_MAX, PREVIEW_BG_VALUES, STORE_NS } from './logic'

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

describe('phantom-tank 持久缓存', () => {
  it('读缓存回填', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_previewBg`]: '"black"',
      [`${STORE_NS}_contrast`]: '200',
    }))
    expect(usePersistedRef(store, 'previewBg', 'white', oneOf(PREVIEW_BG_VALUES)).value).toEqual('black')
    expect(usePersistedRef(store, 'contrast', 100, (x: number) => inRange(x, { min: CONTRAST_MIN * 100, max: CONTRAST_MAX * 100 })).value).toEqual(200)
  })
  it('非法缓存回落默认', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_previewBg`]: '"red"',
      [`${STORE_NS}_contrast`]: '9999',
    }))
    expect(usePersistedRef(store, 'previewBg', 'white', oneOf(PREVIEW_BG_VALUES)).value).toEqual('white')
    expect(usePersistedRef(store, 'contrast', 100, (x: number) => inRange(x, { min: CONTRAST_MIN * 100, max: CONTRAST_MAX * 100 })).value).toEqual(100)
  })
})
