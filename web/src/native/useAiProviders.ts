import { computed, readonly, ref, type ComputedRef, type Ref } from 'vue'
import { aiProviders, offerOf, type AiEntry, type AiProviderInfo, type AiProviders, type AiTask } from './ai'

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
  /** 还没探测过就探测一次；正在探测则等同一次，不重复调原生 */
  ensure: () => Promise<void>
  /** 某任务当前是否有可用提供者 */
  can: (task: AiTask) => boolean
  /** 取支持某任务的可用提供者（按注册顺序）；给了 entry 时还要求该任务走这个入口；没有为 undefined */
  pick: (task: AiTask, entry?: AiEntry) => AiProviderInfo | undefined
}

/**
 * 能力探测组合式函数：挂载后调用一次 `refresh`，页面按 `can(task)` 显示或降级。
 * 探测失败按「没有提供者」处理，不抛给页面。
 *
 * @param fetcher 探测函数，默认 {@link aiProviders}（仅测试注入）
 * @returns 提供者、能力并集、`can` / `pick` / `refresh` / `ensure`
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
  /** 进行中的探测，用于去重 */
  let inflight: Promise<void> | null = null
  /** 探测进行中又收到 refresh：本轮结束后至多再补跑一次，免得回前台的状态变化被旧探测吞掉 */
  let rerun = false

  /** 真正调一次原生，失败当作没有提供者 */
  async function probe(): Promise<void> {
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

  /** 跑一轮探测；期间有人又要求 refresh 时，结束后再跑一轮（只补一次） */
  async function run(): Promise<void> {
    try {
      await probe()
      if (rerun) {
        rerun = false
        await probe()
      }
    } finally {
      rerun = false
      inflight = null
    }
  }

  /** 重新探测；已有进行中的就登记“补跑一次”并等它（含补跑）结束 */
  function refresh(): Promise<void> {
    if (inflight) {
      rerun = true
      return inflight
    }
    inflight = run()
    return inflight
  }

  /** 没探测过才探测；正在探测则等同一次，不触发补跑 */
  function ensure(): Promise<void> {
    if (inflight) return inflight
    return ready.value ? Promise.resolve() : refresh()
  }

  /** 某任务是否有可用提供者 */
  function can(task: AiTask): boolean {
    return capabilities.value.includes(task)
  }

  /** 找支持某任务（可限定入口）的可用提供者 */
  function pick(task: AiTask, entry?: AiEntry): AiProviderInfo | undefined {
    return providers.value.find((p) => p.available && p.tasks.includes(task) && (!entry || !!offerOf(p, task, entry)))
  }

  return {
    providers: readonly(providers) as Readonly<Ref<AiProviderInfo[]>>,
    capabilities: readonly(capabilities) as Readonly<Ref<AiTask[]>>,
    anyAvailable: computed(() => providers.value.some((p) => p.available)),
    ready: readonly(ready),
    refresh,
    ensure,
    can,
    pick,
  }
}

/** 全应用共用的探测实例（选择器、目录、工具页共用一份，避免重复探测） */
let shared: UseAiProviders | null = null

/**
 * 取全应用共用的提供者探测实例；首次调用时创建，不会自动探测（调用方按需 `ensure` / `refresh`）。
 *
 * @returns 共用实例
 * @example const ai = useSharedAiProviders(); await ai.ensure()
 */
export function useSharedAiProviders(): UseAiProviders {
  if (!shared) shared = useAiProviders()
  return shared
}

/** 清掉共用实例（仅测试用） */
export function resetSharedAiProviders(): void {
  shared = null
}
