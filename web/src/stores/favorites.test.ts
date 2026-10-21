import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { FAVORITES_KEY, LEGACY_FAVORITES_KEY, loadFavorites, useFavoritesStore } from './favorites'

/** 内存版 Storage 桩（测试环境是 node，没有 localStorage），方法可被 spy 替换 */
const store = new Map<string, string>()
const fakeStorage = {
  getItem: vi.fn((k: string) => store.get(k) ?? null),
  setItem: vi.fn((k: string, v: string) => void store.set(k, v)),
  removeItem: vi.fn((k: string) => void store.delete(k)),
  clear: () => store.clear(),
}

beforeAll(() => vi.stubGlobal('localStorage', fakeStorage))
afterAll(() => vi.unstubAllGlobals())

/** registry 里真实存在的两个工具 id */
const A = 'ruler'
const B = 'dice'

describe('useFavoritesStore', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('切换收藏：加入、再点移除', () => {
    const s = useFavoritesStore()
    expect(s.toggle(A)).toBe(true)
    expect(s.has(A)).toBe(true)
    expect(s.toggle(A)).toBe(false)
    expect(s.has(A)).toBe(false)
  })

  it('保持收藏顺序', () => {
    const s = useFavoritesStore()
    s.toggle(B)
    s.toggle(A)
    expect(s.list.map((t) => t.id)).toEqual([B, A])
  })

  it('持久化：写入 localStorage，新 store 能读回', () => {
    useFavoritesStore().toggle(A)
    expect(JSON.parse(localStorage.getItem(FAVORITES_KEY)!)).toEqual([A])
    setActivePinia(createPinia())
    expect(useFavoritesStore().ids).toEqual([A])
  })

  it('已下线工具 id 在列表里被忽略，但 ids 保留', () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(['gone-tool', A]))
    setActivePinia(createPinia())
    const s = useFavoritesStore()
    expect(s.list.map((t) => t.id)).toEqual([A])
    expect(s.ids).toEqual(['gone-tool', A])
  })

  it('存储不可用时降级为内存，不抛错', () => {
    const spy = vi.spyOn(fakeStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const s = useFavoritesStore()
    expect(() => s.toggle(A)).not.toThrow()
    expect(s.has(A)).toBe(true)
    spy.mockRestore()
  })
})

describe('loadFavorites 兜底', () => {
  beforeEach(() => localStorage.clear())

  it('没有数据：空数组', () => {
    expect(loadFavorites()).toEqual([])
  })
  it('JSON 损坏：空数组', () => {
    localStorage.setItem(FAVORITES_KEY, '{oops')
    expect(loadFavorites()).toEqual([])
  })
  it('不是数组：空数组', () => {
    localStorage.setItem(FAVORITES_KEY, '{"a":1}')
    expect(loadFavorites()).toEqual([])
  })
  it('混入非字符串与重复项：过滤并去重', () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([A, 3, null, A, B]))
    expect(loadFavorites()).toEqual([A, B])
  })
  it('旧键数据一次性迁移到新键', () => {
    localStorage.setItem(LEGACY_FAVORITES_KEY, JSON.stringify([A, B]))
    expect(loadFavorites()).toEqual([A, B])
    expect(JSON.parse(localStorage.getItem(FAVORITES_KEY)!)).toEqual([A, B])
  })
  it('读取抛错：空数组', () => {
    const spy = vi.spyOn(fakeStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(loadFavorites()).toEqual([])
    spy.mockRestore()
  })
})
