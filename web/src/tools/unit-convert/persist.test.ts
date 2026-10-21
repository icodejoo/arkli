import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { CATEGORIES } from './logic'

/** 内存存储后端 */
function memBackend(init: Record<string, string> = {}): StorageLike {
  const m = new Map<string, string>(Object.entries(init))
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

/** 与 index.vue 相同的类别校验 */
const valid = (v: string): boolean => CATEGORIES.some((c) => c.id === v)

describe('unit-convert 类别持久化', () => {
  it('读缓存回填', () => {
    const id = CATEGORIES[CATEGORIES.length - 1].id
    const store = createToolStorage('unit-convert', memBackend({ 'unit-convert_catId': JSON.stringify(id) }))
    expect(usePersistedRef(store, 'catId', CATEGORIES[0].id, valid).value).toBe(id)
  })
  it('非法缓存回落默认', () => {
    const store = createToolStorage('unit-convert', memBackend({ 'unit-convert_catId': '"nope"' }))
    expect(usePersistedRef(store, 'catId', CATEGORIES[0].id, valid).value).toBe(CATEGORIES[0].id)
  })
})
