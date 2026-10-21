import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { oneOf } from '@/shared/persistValidators'
import { FORMAT_VALUES, GIF_EDGES, PRESET_VALUES, STORE_NS } from './logic'

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

describe('meme-maker 持久缓存', () => {
  it('读缓存回填', () => {
    const store = createToolStorage(STORE_NS, memory({ [`${STORE_NS}_preset`]: '"shake"', [`${STORE_NS}_gifEdge`]: '480' }))
    expect(usePersistedRef(store, 'preset', 'none', oneOf(PRESET_VALUES)).value).toBe('shake')
    expect(usePersistedRef(store, 'gifEdge', 360, oneOf(GIF_EDGES)).value).toBe(480)
  })
  it('非法缓存回落默认', () => {
    const store = createToolStorage(STORE_NS, memory({ [`${STORE_NS}_format`]: '"bmp"', [`${STORE_NS}_gifEdge`]: '999' }))
    expect(usePersistedRef(store, 'format', 'png', oneOf(FORMAT_VALUES)).value).toBe('png')
    expect(usePersistedRef(store, 'gifEdge', 360, oneOf(GIF_EDGES)).value).toBe(360)
  })
})
