import { readonly, ref, type Ref } from 'vue'
import { findTool } from '@/tools/registry'
import { readChoice, writeChoice } from '@/shared/modelPicker'
import { migrateChoice, staticDefault } from '@/shared/aiCatalog'

/** useModelChoice 的返回值 */
export interface UseModelChoice {
  /**
   * 存下的选择值：提供者 id，或过渡项 `model:<清单 id>`；没存过时为工具的静态默认，再没有为 null。
   * 这里不校验它是否仍然有效——有效性要看运行时的提供者与下载状态，由 `useAiCatalog` 的 `choice` 解析。
   */
  choice: Readonly<Ref<string | null>>
  /** 设置选择值并持久化 */
  set: (id: string) => void
}

/** 每个工具共用一个 ref，选择器改了，工具页立刻能读到 */
const cache = new Map<string, Ref<string | null>>()

/**
 * 读出并迁移一个工具存下的选择：旧版存的是清单模型 id，读到时按迁移表换成提供者 id 并写回（只迁一次）。
 *
 * @param toolId 工具 id
 * @returns 迁移后的值；没存过为 null
 */
function loadMigrated(toolId: string): string | null {
  const raw = readChoice(toolId)
  const legacyIds = (findTool(toolId)?.models ?? []).map((m) => m.modelId)
  const next = migrateChoice(raw, legacyIds)
  if (next && next !== raw) writeChoice(toolId, next)
  return next
}

/**
 * 每个工具独立记忆选中的 AI 选项（存提供者 id；还没有提供者的过渡清单模型存 `model:<id>`），存持久缓存 model-choice（仅偏好，读写失败忽略）。
 * 首次读取时把旧版存的清单模型 id 迁移成新值并写回。工具页一般不直接用它，而是用 `useAiCatalog(toolId).choice`（已按运行时解析、失效会回落）。
 *
 * @param toolId 工具 id
 * @returns `choice` 与 `set`
 * @example
 * const { choice } = useModelChoice('waste-sort')
 * // choice.value === 'local-clip'
 */
export function useModelChoice(toolId: string): UseModelChoice {
  let r = cache.get(toolId)
  if (!r) {
    r = ref(loadMigrated(toolId) ?? staticDefault(findTool(toolId)?.models ?? []))
    cache.set(toolId, r)
  }
  const target = r
  return {
    choice: readonly(target) as Readonly<Ref<string | null>>,
    set(id: string): void {
      target.value = id
      writeChoice(toolId, id)
    },
  }
}

/** 清空缓存（仅测试用） */
export function resetModelChoiceCache(): void {
  cache.clear()
}
