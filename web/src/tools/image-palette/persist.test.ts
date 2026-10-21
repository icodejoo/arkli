import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { inRange } from '@/shared/persistValidators'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { loadZoom, ZOOM_DEFAULT, ZOOM_KEY, ZOOM_MAX, ZOOM_MIN } from './logic'

/** 内存存储替身 */
function memory(init: Record<string, string>): StorageLike {
  const m = new Map(Object.entries(init))
  return {
    get length() {
      return m.size
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

/** 放大倍数校验 */
const validZoom = (v: number): boolean => inRange(v, { min: ZOOM_MIN, max: ZOOM_MAX })

describe('image-palette 持久化', () => {
  it('旧版放大倍数迁入并夹到合法范围', () => {
    const st = createToolStorage('image-palette', memory({ [ZOOM_KEY]: '6' }))
    st.adoptLegacy(ZOOM_KEY, 'zoom', loadZoom)
    expect(usePersistedRef(st, 'zoom', ZOOM_DEFAULT, validZoom).value).toBe(6)
  })
  it('非法缓存回落默认', () => {
    const st = createToolStorage('image-palette', memory({ 'image-palette_zoom': '99' }))
    expect(usePersistedRef(st, 'zoom', ZOOM_DEFAULT, validZoom).value).toBe(ZOOM_DEFAULT)
  })
})
