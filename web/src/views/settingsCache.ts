/**
 * 设置页“缓存”卡片的状态与动作：占用刷新、清理防重入。
 * 依赖通过参数注入，便于单测。
 */
import { ref } from 'vue'
import { clearText, statsText, type CacheClearResult, type CacheStats } from '@/native/cache'

/** 缓存卡片依赖 */
export interface CacheCardDeps {
  /** 查询占用 */
  getStats: () => Promise<CacheStats>
  /** 清理缓存 */
  clear: () => Promise<CacheClearResult>
  /** 清理前二次确认，用户取消应 reject */
  confirm: () => Promise<unknown>
  /** 提示 */
  toast: (msg: string) => void
}

/** 未取到占用时的文案 */
export const STATS_UNKNOWN = '缓存占用读取失败'
/** 无宿主时的提示 */
export const CACHE_ONLY_APP = '仅 App 内可用'

/**
 * 缓存卡片状态。
 *
 * @param deps 依赖
 * @returns text 占用文案；busy 是否忙碌；refresh 刷新占用；clean 确认后清理并刷新
 * @example const { text, busy, refresh, clean } = useCacheCard(deps)
 */
export function useCacheCard(deps: CacheCardDeps) {
  /** 占用文案 */
  const text = ref('')
  /** 是否忙碌（刷新或清理中） */
  const busy = ref(false)

  /** 刷新占用，失败显示兜底文案 */
  async function refresh(): Promise<void> {
    try {
      text.value = statsText(await deps.getStats())
    } catch {
      text.value = STATS_UNKNOWN
    }
  }

  /** 二次确认后清理，完成 toast 释放量并刷新；忙碌时忽略 */
  async function clean(): Promise<void> {
    if (busy.value) return
    try {
      await deps.confirm()
    } catch {
      return
    }
    busy.value = true
    try {
      deps.toast(clearText(await deps.clear()))
    } catch (e) {
      const msg = (e as { message?: string }).message
      deps.toast(msg ? `清理失败：${msg}` : '清理失败')
    } finally {
      await refresh()
      busy.value = false
    }
  }

  return { text, busy, refresh, clean }
}
