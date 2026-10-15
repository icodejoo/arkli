/**
 * 模型选择器的纯逻辑：状态映射、标题与备注文案、层过滤、点击分支、选择结果的读写。
 * 不依赖 Vue 与原生，组件与测试都直接用它。
 */
import type { ModelStateName, ModelStatus } from '@/native/model'
import type { ModelLayer, ToolModelOption } from '@/tools/registry'

/** 选择结果在 localStorage 里的键前缀，后接工具 id */
export const CHOICE_KEY_PREFIX = 'arkli.modelChoice.'

/** 顶部下载提示文案 */
export const MSG_DOWNLOADING = '正在下载，可以去AI中心查看'
/** 未接入项点击的 toast 文案 */
export const MSG_NOT_READY = '还没接入'
/** 未接入项备注 */
export const DESC_NOT_READY = '未接入'
/** 点击后跳转的 AI 中心路径 */
export const AI_CENTER_PATH = '/ai'
/** L2 占位项的模型 id */
export const L2_PLACEHOLDER_ID = 'l2-none'
/** L4 占位项的模型 id */
export const L4_OPENAI_ID = 'l4-openai'

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
  /** 选项 id（持久化值） */
  id: string
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

/** 构建行所需的运行时信息 */
export interface BuildContext {
  /** 清单模型状态，按模型 id 索引；不在清单里的模型视为未接入 */
  statuses: Record<string, ModelStatus | undefined>
  /** 当前可用的本机 AI 提供者 id 集合；不含的 L3 项不显示 */
  providerIds: string[]
  /** 当前选中的选项 id */
  selected: string | null
}

/** 点击后的动作 */
export type PickAction = 'select' | 'download' | 'notify' | 'toast'

/** 点击处理的外部依赖（便于测试注入） */
export interface PickDeps {
  /** 选中并关闭弹层 */
  select: (id: string) => void
  /** 启动下载（模型 id） */
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
export function buildDesc(desc: string, status: ItemStatus, st?: ModelStatus): string {
  if (status === 'unsupported') return DESC_NOT_READY
  if (status === 'loading') return `${desc} · 正在下载 ${Math.round(progressOf(st) * 100)}%`
  if (status === 'missing') return `${desc} · 未下载，点击下载`
  return `${desc} · 已安装${st && st.totalBytes > 0 ? ' ' + formatMB(st.totalBytes) : ''}`
}

/** 下载进度 0~1，未知为 0 */
export function progressOf(st?: ModelStatus): number {
  return st && st.totalBytes > 0 ? Math.min(1, st.downloadedBytes / st.totalBytes) : 0
}

/** 全部 L2/L4 占位项（没接入，统一补给每个 AI 工具） */
export const PLACEHOLDERS: ToolModelOption[] = [
  { layer: 'L2', modelId: L2_PLACEHOLDER_ID, title: '暂无', desc: '本地大模型' },
  { layer: 'L4', modelId: L4_OPENAI_ID, title: 'OpenAI', desc: '在线模型' },
]

/** 是否可被选中为结果（L1 已声明的、L3；占位 L2/L4 不可选） */
export function isSelectable(opt: ToolModelOption): boolean {
  return opt.layer === 'L1' || opt.layer === 'L3'
}

/**
 * 层过滤：L3 只有提供者当前可用才保留；其余照旧。
 *
 * @param options 工具声明的选项
 * @param providerIds 可用提供者 id
 * @returns 过滤后的选项
 */
export function filterLayers(options: ToolModelOption[], providerIds: string[]): ToolModelOption[] {
  return options.filter((o) => o.layer !== 'L3' || providerIds.includes(o.modelId))
}

/**
 * 构建选择器的全部行：声明项（过滤后）+ L2/L4 占位，按层 L1~L4 排序。
 *
 * @param declared 工具声明的选项
 * @param ctx 运行时信息
 * @returns 行列表
 */
export function buildItems(declared: ToolModelOption[], ctx: BuildContext): PickerItem[] {
  const all = [...filterLayers(declared, ctx.providerIds), ...PLACEHOLDERS].sort((a, b) => a.layer.localeCompare(b.layer))
  return all.map((o) => {
    const st = o.layer === 'L1' ? ctx.statuses[o.modelId] : undefined
    let status: ItemStatus
    if (o.layer === 'L1') status = stateToStatus(st?.state)
    else if (o.layer === 'L3') status = 'ready'
    else status = 'unsupported'
    if (status === 'ready' && ctx.selected === o.modelId) status = 'selected'
    const desc = o.layer === 'L3' && status !== 'unsupported' ? `${o.desc} · 可用` : buildDesc(o.desc, status, st)
    return { id: o.modelId, layer: o.layer, title: buildTitle(o.layer, o.title), desc, status, progress: progressOf(st) }
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
    await deps.download(item.id)
  } else if (action === 'notify') deps.notifyDownloading()
  else deps.toast(MSG_NOT_READY)
  return action
}

/**
 * 解析最终选中值：存的值仍在可选项里就用它，否则取第一个 L1 项，再没有则 null。
 *
 * @param stored 持久化的值（可能为空或已失效）
 * @param options 工具声明的选项
 * @returns 选项 id 或 null
 */
export function resolveChoice(stored: string | null, options: ToolModelOption[]): string | null {
  const selectable = options.filter(isSelectable)
  if (stored && selectable.some((o) => o.modelId === stored)) return stored
  return options.find((o) => o.layer === 'L1')?.modelId ?? null
}

/** 精简的存储接口，便于测试注入 */
export type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'>

/** 读持久化的选择；任何异常都当作没有 */
export function readChoice(toolId: string, storage?: ChoiceStorage): string | null {
  try {
    return (storage ?? localStorage).getItem(CHOICE_KEY_PREFIX + toolId)
  } catch {
    return null
  }
}

/** 写持久化的选择；失败忽略（仅偏好） */
export function writeChoice(toolId: string, id: string, storage?: ChoiceStorage): void {
  try {
    ;(storage ?? localStorage).setItem(CHOICE_KEY_PREFIX + toolId, id)
  } catch {
    // 无存储环境，忽略
  }
}
