import { computed, getCurrentScope, onScopeDispose, readonly, ref, type ComputedRef, type Ref } from 'vue'
import { defaultModelApi, type ModelApi, type ModelError, type ModelStateName, type ModelStatus } from './model'

/** 下载中的轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 500

/** useModelState 的返回值 */
export interface UseModelState {
  /** 最近一次拿到的状态；首次探测前为 null */
  status: Readonly<Ref<ModelStatus | null>>
  /** 状态名；未探测前按 absent 处理 */
  state: ComputedRef<ModelStateName>
  /** 下载进度 0~1（已落地字节 / 总字节），未知为 0 */
  progress: ComputedRef<number>
  /** 是否正在下载或校验 */
  downloading: ComputedRef<boolean>
  /** 是否已安装且校验通过 */
  installed: ComputedRef<boolean>
  /** 失败原因：最近一次操作抛的错，或原生记录的下载失败 */
  error: ComputedRef<ModelError | null>
  /** 最近一次 ensure 返回的计费网络提示 */
  meteredHint: Readonly<Ref<boolean>>
  /** 是否已完成过至少一次探测；探测前别急着显示「去下载」，免得闪烁 */
  ready: Readonly<Ref<boolean>>
  /** 某个操作正在进行（start / cancel / remove / verify） */
  busy: Readonly<Ref<boolean>>
  /** 探测一次状态，下载中会自动开始轮询 */
  refresh: () => Promise<void>
  /** 开始或续传下载（幂等） */
  start: () => Promise<void>
  /** 取消下载，保留已下载部分 */
  cancel: () => Promise<void>
  /** 删除模型 */
  remove: () => Promise<void>
  /** 重新校验 sha256 */
  verify: () => Promise<void>
  /** 停止轮询；在 effect scope 里创建时会自动调用 */
  dispose: () => void
}

/** 把任意异常转成 ModelError */
function toError(e: unknown): ModelError {
  const o = e as { code?: string; message?: string } | null
  return { code: o?.code ?? 'INTERNAL', message: o?.message ?? '操作失败' }
}

/**
 * 单个本地模型的状态组合式函数：下载中自动轮询，提供进度、状态与 start / cancel / remove / verify。
 * 状态以原生为准，页面重载后调用 `refresh` 即可接上进行中的下载。操作失败不抛给页面，写进 `error`。
 *
 * @param id 模型 id，如 `siglip2-q4_half`
 * @param api 模型管理接口，默认走 bridge（仅测试注入）
 * @param intervalMs 轮询间隔，默认 500 毫秒（仅测试注入）
 * @returns 状态、进度与操作方法
 * @example
 * const m = useModelState('siglip2-q4_half')
 * onMounted(m.refresh)
 * // 模板：<button v-if="!m.installed.value" @click="m.start">下载（{{ Math.round(m.progress.value * 100) }}%）</button>
 */
export function useModelState(id: string, api: ModelApi = defaultModelApi(), intervalMs: number = POLL_INTERVAL_MS): UseModelState {
  /** 最近状态 */
  const status = ref<ModelStatus | null>(null)
  /** 是否探测过 */
  const ready = ref(false)
  /** 操作进行中 */
  const busy = ref(false)
  /** 操作抛出的错误（原生记录的下载失败在 status.error） */
  const actionError = ref<ModelError | null>(null)
  /** 计费网络提示 */
  const meteredHint = ref(false)
  /** 轮询定时器 */
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 已销毁后不再调度 */
  let disposed = false

  /** 停止轮询 */
  function stopPolling(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  /** 状态为下载中则排下一次轮询，否则停止 */
  function schedule(): void {
    stopPolling()
    if (disposed || status.value?.state !== 'downloading') return
    timer = setTimeout(() => {
      timer = null
      void poll()
    }, intervalMs)
  }

  /** 轮询一次：失败只记录并停止，等页面手动 refresh */
  async function poll(): Promise<void> {
    try {
      status.value = await api.status(id)
      actionError.value = null
    } catch (e) {
      actionError.value = toError(e)
      return
    }
    schedule()
  }

  /** 探测一次状态 */
  async function refresh(): Promise<void> {
    try {
      status.value = await api.status(id)
      actionError.value = null
    } catch (e) {
      actionError.value = toError(e)
    } finally {
      ready.value = true
    }
    schedule()
  }

  /** 统一包装一个操作：置 busy，成功更新状态，失败记错误 */
  async function act(fn: () => Promise<ModelStatus>): Promise<void> {
    busy.value = true
    actionError.value = null
    try {
      status.value = await fn()
    } catch (e) {
      actionError.value = toError(e)
    } finally {
      busy.value = false
      ready.value = true
    }
    schedule()
  }

  /** 开始或续传下载 */
  function start(): Promise<void> {
    return act(async () => {
      const r = await api.ensure(id)
      meteredHint.value = r.meteredHint
      return r
    })
  }

  /** 销毁：停轮询 */
  function dispose(): void {
    disposed = true
    stopPolling()
  }

  if (getCurrentScope()) onScopeDispose(dispose)

  return {
    status: readonly(status) as Readonly<Ref<ModelStatus | null>>,
    state: computed(() => status.value?.state ?? 'absent'),
    progress: computed(() => {
      const s = status.value
      return s && s.totalBytes > 0 ? Math.min(1, s.downloadedBytes / s.totalBytes) : 0
    }),
    downloading: computed(() => status.value?.state === 'downloading'),
    installed: computed(() => status.value?.state === 'installed'),
    error: computed(() => actionError.value ?? status.value?.error ?? null),
    meteredHint: readonly(meteredHint),
    ready: readonly(ready),
    busy: readonly(busy),
    refresh,
    start,
    cancel: () => act(() => api.cancel(id)),
    remove: () => act(() => api.remove(id)),
    verify: () => act(() => api.verify(id)),
    dispose,
  }
}
