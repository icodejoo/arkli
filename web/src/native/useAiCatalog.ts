import { computed, type ComputedRef, type Ref } from 'vue'
import { findTool } from '@/tools/registry'
import { useModelsStore } from '@/stores/models'
import { buildCatalog, resolveChoice, type CatalogItem } from '@/shared/aiCatalog'
import { useModelChoice } from './useModelChoice'
import { useSharedAiProviders, type UseAiProviders } from './useAiProviders'

/** useAiCatalog 的返回值 */
export interface UseAiCatalog {
  /** 该工具的全部可选项（选择器的行），按层排序 */
  items: ComputedRef<CatalogItem[]>
  /** 提供者是否已探测过；探测前 `choice` 只是存下的值，别急着提示“没有模型” */
  ready: Readonly<Ref<boolean>>
  /** 当前选择值（已按目录解析：失效回落到第一个 ready 的 L1） */
  choice: ComputedRef<string | null>
  /** 当前选中的目录项；没有为 undefined */
  current: ComputedRef<CatalogItem | undefined>
  /** 选中某项并持久化 */
  set: (key: string) => void
  /** 重新探测提供者（打开选择器时调） */
  refresh: () => Promise<void>
}

/**
 * 一个 AI 工具的模型目录：按工具在 registry 里声明的 `tasks`，从 `native.ai.providers`（共用一次探测）
 * 与模型 store（只读下载状态）合并出可选项，并给出解析后的当前选择。首次调用会触发一次探测（已探测过则不再调）。
 *
 * 工具页只读：`current.status === 'ready'` 才可用；`current.providerId` 传给对应的桥方法；`current.constraints` 是原生给的约束。
 *
 * @param toolId 工具 id
 * @param ai 提供者探测实例，默认全应用共用的那个（仅测试注入）
 * @returns 目录、当前选择与 `set` / `refresh`
 * @example
 * const catalog = useAiCatalog('translate')
 * const provider = computed(() => catalog.current.value?.providerId) // 'local-nllb' | 'local-qwen' | undefined
 * const ready = computed(() => catalog.current.value?.status === 'ready')
 */
export function useAiCatalog(toolId: string, ai: UseAiProviders = useSharedAiProviders()): UseAiCatalog {
  const tool = findTool(toolId)
  const store = useModelsStore()
  const { choice: stored, set } = useModelChoice(toolId)
  void ai.ensure()

  const items = computed(() =>
    buildCatalog({ tasks: tool?.tasks ?? [], models: tool?.models ?? [], providers: ai.providers.value, statuses: store.byId }),
  )
  const choice = computed(() => (ai.ready.value ? resolveChoice(stored.value, items.value) : stored.value))
  const current = computed(() => items.value.find((i) => i.key === choice.value))
  return { items, ready: ai.ready, choice, current, set, refresh: ai.refresh }
}
