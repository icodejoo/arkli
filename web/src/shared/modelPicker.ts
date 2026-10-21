/**
 * 模型选择器的纯逻辑：状态映射、标题与备注文案、点击分支、选择结果的读写。
 * 有哪些行由 AI 目录（`./aiCatalog`）算出，这里只负责把目录项变成展示行。
 * 不依赖 Vue 与原生，组件与测试都直接用它。
 */
import type { ModelStateName, ModelStatus } from '@/native/model'
import type { ModelLayer } from '@/tools/registry'
import type { CatalogItem } from './aiCatalog'
import { createToolStorage, type ToolStorage } from './toolStorage'

/** 选择结果的持久缓存命名空间，键为工具 id（localStorage 里形如 `model-choice_translate`） */
export const CHOICE_NS = 'model-choice'
/** 旧版选择结果的键前缀（后接工具 id，值为原文），读取时一次性迁移 */
export const CHOICE_KEY_PREFIX = 'arkli.modelChoice.'

/** 顶部下载提示文案 */
export const MSG_DOWNLOADING = '正在下载，可以去AI中心查看'
/** 未接入项点击的 toast 文案 */
export const MSG_NOT_READY = '还没接入'
/** 未接入项备注 */
export const DESC_NOT_READY = '未接入'
/** 工具页发现没有就绪模型时的提示文案（只提示，不指定下载入口） */
export const MSG_NO_MODEL = '无可用模型，去查看'
/** 点击后跳转的 AI 中心路径 */
export const AI_CENTER_PATH = '/ai'

/** 层名 */
export const LAYER_NAMES: Record<ModelLayer, string> = {
  L1: '本地小模型',
  L2: '本地大模型',
  L3: '本机AI',
  L4: '远端API',
}

/** 一行的展示状态：ready 已下载未选中 / selected 当前选中 / missing 未下载（置灰可点） / loading 下载中 / unsupported 未接入 */
export type ItemStatus = 'ready' | 'selected' | 'missing' | 'loading' | 'unsupported'

/** 选择器的一行 */
export interface PickerItem {
  /** 选项 id（持久化值，即目录项的 key） */
  id: string
  /** 要下载的清单模型 id；没有则用 id */
  modelId?: string
  /** 层级 */
  layer: ModelLayer
  /** 标题「层名-模型名」 */
  title: string
  /** 备注 */
  desc: string
  /** 展示状态 */
  status: ItemStatus
  /** 下载进度 0~1，仅 loading 有意义 */
  progress: number
}

/** 点击后的动作 */
export type PickAction = 'select' | 'download' | 'notify' | 'toast'

/** 点击处理的外部依赖（便于测试注入） */
export interface PickDeps {
  /** 选中并关闭弹层 */
  select: (id: string) => void
  /** 启动下载（清单模型 id） */
  download: (id: string) => Promise<unknown>
  /** 弹出可点击的「正在下载」提示 */
  notifyDownloading: () => void
  /** 弹 toast */
  toast: (msg: string) => void
}

/** 格式化字节为 MB，一位小数；如 54662805 -> `54.7MB` */
export function formatMB(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)}MB`
}

/**
 * 模型状态映射为展示状态（不含「选中」，选中由 id 比较决定）。
 * installed -> ready；downloading -> loading；absent/unverified/corrupt -> missing（置灰，点击会重新 ensure：
 * unverified 触发校验，corrupt 重新下载）；没有状态（不在清单）-> unsupported。
 *
 * @param state 原生状态名，未知传 undefined
 * @returns 展示状态
 * @example stateToStatus('installed') // 'ready'
 */
export function stateToStatus(state: ModelStateName | undefined): Exclude<ItemStatus, 'selected'> {
  if (!state) return 'unsupported'
  if (state === 'installed') return 'ready'
  if (state === 'downloading') return 'loading'
  return 'missing'
}

/**
 * 拼标题「层名-模型名」。
 *
 * @param layer 层级
 * @param name 模型名
 * @returns 如「本地小模型-OCR」
 */
export function buildTitle(layer: ModelLayer, name: string): string {
  return `${LAYER_NAMES[layer]}-${name}`
}

/**
 * 拼备注：作用 + 状态提示。
 *
 * @param desc 模型作用
 * @param status 展示状态
 * @param st 清单状态（取体积与进度）
 * @returns 如「识别垃圾品类 · 已安装 54.7MB」
 */
export function buildDesc(desc: string, status: ItemStatus, st?: Pick<ModelStatus, 'totalBytes' | 'downloadedBytes'>): string {
  if (status === 'unsupported') return DESC_NOT_READY
  if (status === 'loading') return `${desc} · 正在下载 ${Math.round(progressOf(st) * 100)}%`
  if (status === 'missing') return `${desc} · 未下载，点击下载`
  return `${desc} · 已安装${st && st.totalBytes > 0 ? ' ' + formatMB(st.totalBytes) : ''}`
}

/** 下载进度 0~1，未知为 0 */
export function progressOf(st?: Pick<ModelStatus, 'totalBytes' | 'downloadedBytes'>): number {
  return st && st.totalBytes > 0 ? Math.min(1, st.downloadedBytes / st.totalBytes) : 0
}

/**
 * 把 AI 目录变成选择器的行：标题加层名、备注加状态，当前选中且就绪的着色。本机 AI 项备注写「可用」。
 *
 * @param catalog 目录（已按层排好、已过滤掉不适用与不可用的本机 AI）
 * @param selected 当前选中的选择值
 * @returns 行列表
 * @example buildItems(catalog, 'local-nllb')[0].status // 'selected'
 */
export function buildItems(catalog: readonly CatalogItem[], selected: string | null): PickerItem[] {
  return catalog.map((c) => {
    const status: ItemStatus = c.status === 'ready' && selected === c.key ? 'selected' : c.status
    const desc = c.layer === 'L3' && status !== 'unsupported' ? `${c.desc} · 可用` : buildDesc(c.desc, status, c)
    return { id: c.key, modelId: c.modelId, layer: c.layer, title: buildTitle(c.layer, c.title), desc, status, progress: progressOf(c) }
  })
}

/**
 * 按行状态决定点击动作：ready/selected -> select；missing -> download；loading -> notify；unsupported -> toast。
 *
 * @param item 被点的行
 * @returns 动作
 */
export function decideAction(item: PickerItem): PickAction {
  if (item.status === 'ready' || item.status === 'selected') return 'select'
  if (item.status === 'missing') return 'download'
  if (item.status === 'loading') return 'notify'
  return 'toast'
}

/**
 * 执行点击：选中 / 下载并提示 / 仅提示（不重复下载）/ toast。
 *
 * @param item 被点的行
 * @param deps 外部依赖
 * @returns 实际执行的动作
 */
export async function handlePick(item: PickerItem, deps: PickDeps): Promise<PickAction> {
  const action = decideAction(item)
  if (action === 'select') deps.select(item.id)
  else if (action === 'download') {
    deps.notifyDownloading()
    await deps.download(item.modelId ?? item.id)
  } else if (action === 'notify') deps.notifyDownloading()
  else deps.toast(MSG_NOT_READY)
  return action
}

/** 非模型资源行（如语料库数据包）的展示信息 */
export interface ExtraRowInfo {
  /** 行 id（选中时回传给页面，不能与目录项 key 重名） */
  id: string
  /** 要下载的清单 id */
  modelId: string
  /** 标题 */
  title: string
  /** 作用说明 */
  desc: string
}

/**
 * 把一个清单资源（如对联语料库）做成选择器的一行：状态同模型行，已安装且被页面选中时为「选中」。
 *
 * @param info 行信息
 * @param st 清单状态，还没拿到快照传 undefined（按未接入）
 * @param selected 页面当前是否选了它
 * @returns 一行
 * @example buildExtraItem({ id: 'corpus', modelId: 'couplet-corpus', title: '语料库', desc: '73 万副' }, st, true).status // 'selected'
 */
export function buildExtraItem(info: ExtraRowInfo, st: (Pick<ModelStatus, 'totalBytes' | 'downloadedBytes'> & { state: ModelStateName }) | undefined, selected: boolean): PickerItem {
  const base = stateToStatus(st?.state)
  const status: ItemStatus = base === 'ready' && selected ? 'selected' : base
  return { id: info.id, modelId: info.modelId, layer: 'L1', title: info.title, desc: buildDesc(info.desc, status, st), status, progress: progressOf(st) }
}

/** 选择结果的默认持久缓存 */
const choiceStore = createToolStorage(CHOICE_NS)

/**
 * 读持久化的选择（顺带迁移旧键）；任何异常都当作没有。
 *
 * @param toolId 工具 id
 * @param store 持久缓存，默认 model-choice 命名空间（测试注入）
 * @returns 选择值；没存过为 null
 */
export function readChoice(toolId: string, store: ToolStorage = choiceStore): string | null {
  store.adoptLegacy(CHOICE_KEY_PREFIX + toolId, toolId, (raw) => raw)
  const v = store.get<unknown>(toolId, null)
  return typeof v === 'string' ? v : null
}

/**
 * 写持久化的选择；失败忽略（仅偏好）。
 *
 * @param toolId 工具 id
 * @param id 选择值
 * @param store 持久缓存，默认 model-choice 命名空间（测试注入）
 */
export function writeChoice(toolId: string, id: string, store: ToolStorage = choiceStore): void {
  store.set(toolId, id)
}

/** 选择器的一个分组：多类模型同屏分开选时，每类一组 */
export interface PickerSection {
  /** 工具 id（目录与记忆的选择都按它） */
  toolId: string
  /** 分组标题 */
  title: string
}
