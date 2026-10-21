import { defineStore } from 'pinia'
import { findTool } from '@/tools/registry'

/** 被浮起的工具 */
export interface FloatingTool {
  /** 工具 id */
  id: string
  /** 工具名称（圆球无障碍标签与替换确认用） */
  name: string
}

/** 点“浮窗”后的处理结果：忙碌不能浮 / 需要确认替换 / 直接浮 */
export type FloatDecision = 'busy' | 'confirm' | 'go'

/**
 * 判断点“浮窗”后该怎么办。
 *
 * @param busy 当前工具是否有不可暂停的任务
 * @param floating 现有浮窗
 * @param id 要浮起的工具 id
 * @returns busy 提示忙碌；confirm 已有别的浮窗要先确认；go 直接浮起
 * @example
 * decideFloat(false, { id: 'a', name: 'A' }, 'b') // 'confirm'
 */
export function decideFloat(busy: boolean, floating: FloatingTool | null, id: string): FloatDecision {
  if (busy) return 'busy'
  return floating && floating.id !== id ? 'confirm' : 'go'
}

/**
 * 浮窗：全局最多一个被浮起的工具，以及各工具的忙碌计数（不持久化，刷新即清空）。
 * 工具实例的存活由 ToolView 依据 `floating` 决定，详见 docs/design/float-window.md。
 */
export const useFloatStore = defineStore('float', {
  state: () => ({
    /** 当前浮窗，没有为 null */
    floating: null as FloatingTool | null,
    /** 各工具的忙碌计数（一个工具可有多个忙碌来源，计数 > 0 即忙碌） */
    busy: {} as Record<string, number>,
  }),
  actions: {
    /**
     * 某个工具是否有不可暂停的任务。
     *
     * @param id 工具 id
     * @returns 忙碌返回 true
     */
    isBusy(id: string): boolean {
      return (this.busy[id] ?? 0) > 0
    },
    /**
     * 浮起工具（替换已有浮窗）。
     *
     * @param id 工具 id
     * @returns 工具存在并已浮起返回 true
     * @example
     * useFloatStore().float('pomodoro') // true
     */
    float(id: string): boolean {
      const t = findTool(id)
      if (!t) return false
      this.floating = { id: t.id, name: t.name }
      return true
    },
    /**
     * 取回浮窗：清空状态并返回被浮起的工具 id（实例由调用方让它回到前台）。
     *
     * @returns 原浮窗的工具 id；没有浮窗为 null
     */
    restore(): string | null {
      const id = this.floating?.id ?? null
      this.floating = null
      return id
    },
    /** 关闭浮窗：清空状态，ToolView 随之销毁被浮起的实例 */
    close(): void {
      this.floating = null
    },
    /**
     * 汇报某工具的一个忙碌来源开始或结束（每个来源须成对汇报，推荐用 useFloatBusy）。
     *
     * @param id 工具 id
     * @param busy true 开始忙碌，false 结束
     */
    reportBusy(id: string, busy: boolean): void {
      const n = (this.busy[id] ?? 0) + (busy ? 1 : -1)
      if (n > 0) this.busy[id] = n
      else delete this.busy[id]
    },
  },
})
