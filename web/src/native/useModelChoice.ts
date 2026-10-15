import { readonly, ref, type Ref } from 'vue'
import { findTool } from '@/tools/registry'
import { readChoice, resolveChoice, writeChoice } from '@/shared/modelPicker'

/** useModelChoice 的返回值 */
export interface UseModelChoice {
  /** 当前选中的模型 id；工具没声明可选模型时为 null */
  choice: Readonly<Ref<string | null>>
  /** 设置选中的模型 id 并持久化 */
  set: (id: string) => void
}

/** 每个工具共用一个 ref，选择器改了，工具页立刻能读到 */
const cache = new Map<string, Ref<string | null>>()

/**
 * 每个工具独立记忆当前选中的模型 id，存 localStorage（仅偏好，读写失败忽略）。
 * 默认值为该工具声明的第一个 L1 模型；已存的值失效（不再是可选项）时也回落到默认值。
 * 本版只记录选择，不改各工具的推理引擎，工具按需读取 `choice`。
 *
 * @param toolId 工具 id
 * @returns `choice` 与 `set`
 * @example
 * const { choice } = useModelChoice('waste-sort')
 * // choice.value === 'siglip2-q4_half'
 */
export function useModelChoice(toolId: string): UseModelChoice {
  let r = cache.get(toolId)
  if (!r) {
    r = ref(resolveChoice(readChoice(toolId), findTool(toolId)?.models ?? []))
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
