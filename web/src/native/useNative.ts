import { getCurrentScope, onScopeDispose, readonly, ref, type Ref } from 'vue'
import { call as bridgeCall, on as bridgeOn, type CallOptions, type EventHandler } from './bridge'
import type { BridgeError } from './protocol'

/** useNative 的返回值 */
export interface UseNative {
  /** 调用原生方法；在途计数与 error 由本组合式函数维护，失败仍会 reject */
  call: <T = unknown>(method: string, params?: Record<string, unknown>, options?: CallOptions) => Promise<T>
  /** 订阅原生事件，作用域销毁时自动解绑；返回手动解绑函数 */
  on: (event: string, handler: EventHandler) => () => void
  /** 是否有本组件发起的请求在途 */
  loading: Readonly<Ref<boolean>>
  /** 最近一次失败；下次调用成功后清空。主动取消（CANCELLED）不计入 */
  error: Readonly<Ref<BridgeError | null>>
  /** 取消本组件发起的全部在途请求（向原生发 native.task.cancel） */
  cancelAll: () => void
}

/**
 * 组件内使用 bridge 的组合式函数：跟踪在途请求、记录错误、随作用域销毁自动解绑与取消。
 *
 * @returns call / on / loading / error / cancelAll
 * @example
 * const { call, loading, error } = useNative()
 * const { items } = await call<{ items: unknown[] }>('native.file.pick', { mime: 'image/*' })
 */
export function useNative(): UseNative {
  /** 在途请求数 */
  const pending = ref(0)
  /** 是否在途（pending > 0） */
  const loading = ref(false)
  /** 最近一次错误 */
  const error = ref<BridgeError | null>(null)
  /** 在途请求的中止控制器 */
  const controllers = new Set<AbortController>()
  /** 本作用域订阅的解绑函数 */
  const offs = new Set<() => void>()
  /** 作用域是否已销毁 */
  let disposed = false

  /** 取消全部在途请求 */
  function cancelAll(): void {
    controllers.forEach((ac) => ac.abort())
  }

  /** 包装 bridge.call */
  async function call<T = unknown>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    const ac = new AbortController()
    // 外部传入的 signal 联动到内部控制器
    const outer = options.signal
    if (outer) {
      if (outer.aborted) ac.abort()
      else outer.addEventListener('abort', () => ac.abort(), { once: true })
    }
    controllers.add(ac)
    pending.value++
    loading.value = true
    try {
      const data = await bridgeCall<T>(method, params, { ...options, signal: ac.signal })
      if (!disposed) error.value = null
      return data
    } catch (e) {
      const err = e as BridgeError
      if (!disposed && err.code !== 'CANCELLED') error.value = err
      throw e
    } finally {
      controllers.delete(ac)
      pending.value--
      loading.value = pending.value > 0
    }
  }

  /** 订阅事件并登记解绑 */
  function on(event: string, handler: EventHandler): () => void {
    const off = bridgeOn(event, handler)
    const wrapped = () => {
      off()
      offs.delete(wrapped)
    }
    offs.add(wrapped)
    return wrapped
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
      cancelAll()
      Array.from(offs).forEach((off) => off())
    })
  }

  return { call, on, loading: readonly(loading), error: readonly(error), cancelAll }
}
