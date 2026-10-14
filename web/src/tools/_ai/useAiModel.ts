import { onMounted, ref } from 'vue'
import { getAiStatus, type AiModel } from '@/native/ai'

/**
 * 包装 getAiStatus：给页面一个「某个模型是否就绪」的响应式状态，并支持重试。
 *
 * @param model 页面依赖的模型名
 * @param autoLoad 挂载时是否自动查询，默认 true
 * @returns ready 是否就绪；checked 是否已查询过；loading 查询中；refresh 重新查询；markNotReady 调用抛 AiNotReadyError 后手动标记
 * @example
 * const { ready, refresh } = useAiModel('ocr')
 */
export function useAiModel(model: AiModel, autoLoad = true) {
  /** 模型是否就绪 */
  const ready = ref(false)
  /** 是否已经查询过一次 */
  const checked = ref(false)
  /** 是否查询中 */
  const loading = ref(false)

  /** 重新查询状态；查询本身出错时按未就绪处理 */
  async function refresh(): Promise<void> {
    if (loading.value) return
    loading.value = true
    try {
      ready.value = (await getAiStatus()).models[model]
    } catch {
      ready.value = false
    } finally {
      loading.value = false
      checked.value = true
    }
  }

  /** 调用时撞上「模型未就绪」，直接把状态改成未就绪 */
  function markNotReady(): void {
    ready.value = false
    checked.value = true
  }

  if (autoLoad) onMounted(refresh)

  return { ready, checked, loading, refresh, markNotReady }
}
