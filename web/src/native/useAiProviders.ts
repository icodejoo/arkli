import { computed, readonly, ref, type ComputedRef, type Ref } from 'vue'
import { aiProviders, type AiProviderInfo, type AiProviders, type AiTask } from './ai'

/** useAiProviders 的返回值 */
export interface UseAiProviders {
  /** 全部提供者，含不可用的 */
  providers: Readonly<Ref<AiProviderInfo[]>>
  /** 可用提供者支持的任务并集 */
  capabilities: Readonly<Ref<AiTask[]>>
  /** 是否至少有一个可用提供者；页面据此显示或隐藏整个入口 */
  anyAvailable: ComputedRef<boolean>
  /** 是否已完成过至少一次探测；探测前别急着隐藏入口，免得闪烁 */
  ready: Readonly<Ref<boolean>>
  /** 重新探测（装了新应用、回到前台后可再调） */
  refresh: () => Promise<void>
  /** 某任务当前是否有可用提供者 */
  can: (task: AiTask) => boolean
  /** 取支持某任务的可用提供者（按注册顺序），没有为 undefined */
  pick: (task: AiTask) => AiProviderInfo | undefined
}

/**
 * 能力探测组合式函数：挂载后调用一次 `refresh`，页面按 `can(task)` 显示或降级。
 * 探测失败按「没有提供者」处理，不抛给页面。
 *
 * @param fetcher 探测函数，默认 {@link aiProviders}（仅测试注入）
 * @returns 提供者、能力并集、`can` / `pick` / `refresh`
 * @example
 * const ai = useAiProviders()
 * onMounted(ai.refresh)
 * // 模板：<button v-if="ai.can('translate')" @click="send">交给翻译应用</button>
 */
export function useAiProviders(fetcher: () => Promise<AiProviders> = () => aiProviders()): UseAiProviders {
  /** 提供者列表 */
  const providers = ref<AiProviderInfo[]>([])
  /** 任务并集 */
  const capabilities = ref<AiTask[]>([])
  /** 是否探测过 */
  const ready = ref(false)

  /** 重新探测，失败当作没有提供者 */
  async function refresh(): Promise<void> {
    try {
      const r = await fetcher()
      providers.value = r.providers
      capabilities.value = r.capabilities
    } catch {
      providers.value = []
      capabilities.value = []
    } finally {
      ready.value = true
    }
  }

  /** 某任务是否有可用提供者 */
  function can(task: AiTask): boolean {
    return capabilities.value.includes(task)
  }

  /** 找支持某任务的可用提供者 */
  function pick(task: AiTask): AiProviderInfo | undefined {
    return providers.value.find((p) => p.available && p.tasks.includes(task))
  }

  return {
    providers: readonly(providers) as Readonly<Ref<AiProviderInfo[]>>,
    capabilities: readonly(capabilities) as Readonly<Ref<AiTask[]>>,
    anyAvailable: computed(() => providers.value.some((p) => p.available)),
    ready: readonly(ready),
    refresh,
    can,
    pick,
  }
}
