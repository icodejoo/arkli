import { defineStore } from 'pinia'
import { tools, type ToolMeta } from '@/tools/registry'

/** 最近使用列表的长度上限 */
const RECENT_LIMIT = 5

/** 工具列表与最近使用记录（仅内存，不持久化） */
export const useToolsStore = defineStore('tools', {
  state: () => ({
    /** 全部工具 */
    all: tools as ToolMeta[],
    /** 最近使用的工具 id，最新的在前 */
    recentIds: [] as string[],
  }),
  getters: {
    /** 最近使用的工具元信息，已过滤掉不存在的 id */
    recent(state): ToolMeta[] {
      return state.recentIds
        .map((id) => state.all.find((t) => t.id === id))
        .filter((t): t is ToolMeta => !!t)
    },
  },
  actions: {
    /**
     * 记录一次使用：置顶并去重，超出上限的丢弃。
     *
     * @param id 工具 id
     * @example
     * useToolsStore().markUsed('bridge-probe')
     */
    markUsed(id: string): void {
      this.recentIds = [id, ...this.recentIds.filter((x) => x !== id)].slice(0, RECENT_LIMIT)
    },
  },
})
