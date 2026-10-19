import { shallowReactive } from 'vue'
import { defineStore } from 'pinia'
import {
  aiParamsGet,
  aiParamsReset,
  aiParamsSet,
  type AiParamsState,
} from '@/native/ai'

/**
 * AI 模型可调参数 store（按 providerId 缓存）：
 * 打开面板时加载一次，写入与重置后用原生返回值直接更新缓存。
 * 不轮询、不监听原生事件。
 *
 * @example
 * const store = useAiParamsStore()
 * await store.load('local-qwen')
 * const state = store.get('local-qwen')
 */
export const useAiParamsStore = defineStore('aiParams', () => {
  /** 各提供者的参数状态缓存，按 providerId 索引 */
  const cache = shallowReactive<Record<string, AiParamsState>>({})
  /** 进行中的加载 Promise，用于相同 providerId 调用的防重合并 */
  const inflight = new Map<string, Promise<AiParamsState>>()

  /**
   * 获取某个提供者已缓存的参数状态。
   *
   * @param providerId 提供者 id
   * @returns 缓存的参数状态，未加载过则为 undefined
   * @example const state = store.get('local-qwen')
   */
  function get(providerId: string): AiParamsState | undefined {
    return cache[providerId]
  }

  /**
   * 加载提供者的参数；默认优先使用已有缓存，force 为 true 时强制从原生刷新。
   *
   * @param providerId 提供者 id
   * @param force 是否强制向原生刷新
   * @returns 参数状态
   * @example const state = await store.load('local-qwen')
   */
  async function load(providerId: string, force = false): Promise<AiParamsState> {
    if (!force && cache[providerId]) return cache[providerId]
    const pending = inflight.get(providerId)
    if (pending) return pending

    const promise = aiParamsGet(providerId)
      .then((res) => {
        cache[providerId] = res
        return res
      })
      .finally(() => {
        inflight.delete(providerId)
      })

    inflight.set(providerId, promise)
    return promise
  }

  /**
   * 设置提供者的参数值，并用返回值更新缓存。
   *
   * @param providerId 提供者 id
   * @param values 要修改的键值对
   * @returns 修改后的最新状态
   * @example await store.set('local-qwen', { temperature: 0.8 })
   */
  async function set(providerId: string, values: Record<string, number>): Promise<AiParamsState> {
    const res = await aiParamsSet(providerId, values)
    cache[providerId] = res
    return res
  }

  /**
   * 重置提供者的参数为默认值，并用返回值更新缓存。
   *
   * @param providerId 提供者 id
   * @param keys 要重置的键名列表，缺省为全部重置
   * @returns 重置后的最新状态
   * @example await store.reset('local-qwen')
   */
  async function reset(providerId: string, keys?: string[]): Promise<AiParamsState> {
    const res = await aiParamsReset(providerId, keys)
    cache[providerId] = res
    return res
  }

  return {
    cache,
    get,
    load,
    set,
    reset,
  }
})
