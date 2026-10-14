import { defineStore } from 'pinia'
import { findTool, type ToolMeta } from '@/tools/registry'

/** localStorage 里存收藏 id 数组的键 */
export const FAVORITES_KEY = 'arkli.favorites'

/**
 * 读取已存的收藏 id；存储不可用、数据损坏或类型不对时返回空数组。
 *
 * @returns 收藏的工具 id，保持收藏顺序、已去重
 */
export function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    if (!raw) return []
    const data: unknown = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return [...new Set(data.filter((x): x is string => typeof x === 'string'))]
  } catch {
    return []
  }
}

/**
 * 写入收藏 id；存储不可用（隐私模式、配额满）时静默忽略，内存状态照常工作。
 *
 * @param ids 收藏的工具 id
 */
export function saveFavorites(ids: string[]): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids))
  } catch {
    // 降级为只在内存里
  }
}

/** 收藏：id 列表（按收藏先后）持久化到 localStorage，展示时过滤掉已下线的工具 */
export const useFavoritesStore = defineStore('favorites', {
  state: () => ({
    /** 收藏的工具 id，最早收藏的在前 */
    ids: loadFavorites(),
  }),
  getters: {
    /** 收藏的工具元信息，保持收藏顺序，registry 里不存在的 id 被忽略 */
    list(state): ToolMeta[] {
      return state.ids.map((id) => findTool(id)).filter((t): t is ToolMeta => !!t)
    },
  },
  actions: {
    /**
     * 某个工具是否已收藏。
     *
     * @param id 工具 id
     * @returns 已收藏返回 true
     */
    has(id: string): boolean {
      return this.ids.includes(id)
    },
    /**
     * 切换收藏状态并持久化：未收藏则追加到末尾，已收藏则移除。
     *
     * @param id 工具 id
     * @returns 切换后是否处于收藏状态
     * @example
     * useFavoritesStore().toggle('ruler') // true
     */
    toggle(id: string): boolean {
      const on = !this.has(id)
      this.ids = on ? [...this.ids, id] : this.ids.filter((x) => x !== id)
      saveFavorites(this.ids)
      return on
    },
  },
})
