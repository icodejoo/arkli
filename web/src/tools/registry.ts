import type { Component } from 'vue'

/** 工具元信息 */
export interface ToolMeta {
  /** 工具唯一标识，用于路由 `/tool/:id` */
  id: string
  /** 展示名称 */
  name: string
  /** 一句话简介 */
  description: string
  /** 懒加载组件，每个工具会被打成独立 chunk */
  load: () => Promise<{ default: Component }>
}

/**
 * 工具注册表。新增工具：在 `src/tools/<id>/` 下建 index.vue，再在此处加一行。
 */
export const tools: ToolMeta[] = [
  {
    id: 'bridge-probe',
    name: 'Bridge 探针',
    description: '检测与原生/Rust 的通信是否正常',
    load: () => import('./bridge-probe/index.vue'),
  },
]

/**
 * 按 id 查工具。
 *
 * @param id 工具 id
 * @returns 工具元信息；不存在时为 undefined
 * @example
 * findTool('bridge-probe')?.name // 'Bridge 探针'
 */
export function findTool(id: string): ToolMeta | undefined {
  return tools.find((t) => t.id === id)
}
