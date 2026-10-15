import { computed, shallowReactive } from 'vue'
import { defineStore } from 'pinia'
import { on } from '@/native/bridge'
import {
  MODEL_EVENT,
  modelCancel,
  modelEnsure,
  modelList,
  modelRemove,
  modelVerify,
  type ModelEnsureResult,
  type ModelStatus,
} from '@/native/model'

/** 模型 id 到用途说明的映射（原生清单不带用途，这里补） */
const MODEL_PURPOSES: Record<string, string> = {
  'siglip2-q4_half': '识别垃圾品类',
  'nllb600m-un6-ccm-int4': '多语翻译',
}

/** 没登记用途的模型的兜底文案 */
const DEFAULT_PURPOSE = 'AI 模型'

/**
 * 一个本地 AI 模型的完整信息（只读）。接入方（工具页、模型选择器、AI 中心）只依赖这个类型，
 * 不关心状态怎么来：原生推送、启动时的一次快照、store 里怎么存，都是 store 的事。
 */
export interface AiModel extends ModelStatus {
  /** 用途说明，如「识别垃圾品类」 */
  readonly purpose: string
  /** 已安装且校验通过，可以直接使用 */
  readonly installed: boolean
  /** 正在下载或校验 */
  readonly downloading: boolean
  /** 下载进度 0~1，未知为 0 */
  readonly progress: number
}

/** 把原生状态补成 {@link AiModel} */
function toModel(s: ModelStatus): AiModel {
  return {
    ...s,
    purpose: MODEL_PURPOSES[s.id] ?? DEFAULT_PURPOSE,
    installed: s.state === 'installed',
    downloading: s.state === 'downloading',
    progress: s.totalBytes > 0 ? Math.min(1, s.downloadedBytes / s.totalBytes) : 0,
  }
}

/**
 * 本地 AI 模型的唯一状态源（浅响应式）：启动时向原生取一次全量快照，之后全靠原生推送的 `model.changed`
 * 事件更新，每次推送整体替换该模型对象，所有读取方自动刷新，不需要轮询。
 *
 * 管理动作（下载、取消、删除、校验）也只在这里：AI 中心用全部，模型选择器只用 `download`，业务工具页只读。
 *
 * 使用示例：
 * ```ts
 * const store = useModelsStore()
 * const m = computed(() => store.get('siglip2-q4_half'))   // AiModel | undefined
 * if (m.value?.installed) { ... }
 * ```
 */
export const useModelsStore = defineStore('models', () => {
  /** 全部模型，按 id 索引；值整体替换，所以浅响应式就够 */
  const byId = shallowReactive<Record<string, AiModel>>({})
  /** 已收到过推送的 id：初始快照晚到时不能覆盖更新的推送 */
  const touched = new Set<string>()
  /** 是否已初始化 */
  let started = false

  /** 全部模型列表 */
  const list = computed(() => Object.values(byId))

  /** 写入一个模型的最新状态 */
  function apply(s: ModelStatus, fromEvent: boolean): void {
    if (fromEvent) touched.add(s.id)
    else if (touched.has(s.id)) return
    byId[s.id] = toModel(s)
  }

  /**
   * 初始化（幂等）：订阅原生事件并取一次全量快照。应用启动时调一次。
   *
   * @example useModelsStore().init()
   */
  function init(): void {
    if (started) return
    started = true
    on(MODEL_EVENT, (data) => apply(data as ModelStatus, true))
    modelList()
      .then((all) => all.forEach((s) => apply(s, false)))
      .catch(() => undefined)
  }

  /**
   * 取某个模型；清单里没有（或还没拿到快照）为 undefined。
   *
   * @param id 模型 id
   * @returns 模型信息
   */
  function get(id: string): AiModel | undefined {
    return byId[id]
  }

  /**
   * 开始或续传下载（幂等）。进度与结果由推送更新；这里的返回值只给调用方看计费网络提示。
   *
   * @param id 模型 id
   * @returns 原生返回，含 `meteredHint`
   * @throws 无宿主或 id 不在清单里
   */
  async function download(id: string): Promise<ModelEnsureResult> {
    const r = await modelEnsure(id)
    apply(r, true)
    return r
  }

  /** 取消下载，保留已下载部分 */
  async function cancel(id: string): Promise<void> {
    apply(await modelCancel(id), true)
  }

  /** 删除模型 */
  async function remove(id: string): Promise<void> {
    apply(await modelRemove(id), true)
  }

  /** 重新校验 sha256 */
  async function verify(id: string): Promise<void> {
    apply(await modelVerify(id), true)
  }

  return { byId, list, init, get, download, cancel, remove, verify }
})
