import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { oneOf, inRange } from '@/shared/persistValidators'
import { ECC_OPTIONS, BORDER_MIN, BORDER_MAX, SIZE_MIN, SIZE_MAX, STORE_NS } from './logic'

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

describe('qrcode-gen 持久缓存', () => {
  it('读缓存回填', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_ecc`]: '"H"',
      [`${STORE_NS}_border`]: '2',
      [`${STORE_NS}_size`]: '256',
    }))
    expect(usePersistedRef(store, 'ecc', 'M', oneOf(ECC_OPTIONS.map((o) => o.id))).value).toEqual('H')
    expect(usePersistedRef(store, 'border', 4, (x: number) => inRange(x, { min: BORDER_MIN, max: BORDER_MAX })).value).toEqual(2)
    expect(usePersistedRef(store, 'size', 512, (x: number) => inRange(x, { min: SIZE_MIN, max: SIZE_MAX })).value).toEqual(256)
  })
  it('非法缓存回落默认', () => {
    const store = createToolStorage(STORE_NS, memory({
      [`${STORE_NS}_ecc`]: '"Z"',
      [`${STORE_NS}_border`]: '99',
      [`${STORE_NS}_size`]: '99999',
    }))
    expect(usePersistedRef(store, 'ecc', 'M', oneOf(ECC_OPTIONS.map((o) => o.id))).value).toEqual('M')
    expect(usePersistedRef(store, 'border', 4, (x: number) => inRange(x, { min: BORDER_MIN, max: BORDER_MAX })).value).toEqual(4)
    expect(usePersistedRef(store, 'size', 512, (x: number) => inRange(x, { min: SIZE_MIN, max: SIZE_MAX })).value).toEqual(512)
  })
})
