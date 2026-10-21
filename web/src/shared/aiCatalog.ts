/**
 * AI 目录的纯逻辑：给定工具声明的任务，从 `native.ai.providers`（报价、层、可用性、模型信息）与模型 store（下载状态）
 * 合并出该工具的可选项，并负责选择值的解析与旧值迁移。不依赖 Vue 与原生，组合式函数与测试都直接用它。
 * 设计见 docs/design/model-picker.md 与 docs/design/ai-protocol.md。
 */
import type { AiEntry, AiLayer, AiOffer, AiOfferConstraints, AiProviderInfo, AiTask } from '@/native/ai'
import type { ModelStatus } from '@/native/model'
import type { ToolAiTask, ToolModelOption } from '@/tools/registry'
import { stateToStatus } from './modelPicker'

/** 过渡项（还没有原生提供者的清单模型）选择值的前缀，后接清单模型 id */
export const MODEL_KEY_PREFIX = 'model:'
/** 系统应用交接提供者的 id（与 native/ai 的 HANDOFF_PROVIDER_ID 一致；本模块要保持纯逻辑，不引入带 window 依赖的 native/ai 值导入） */
const HANDOFF_ID = 'intent-handoff'
/** L4 占位项的选择值（不可选） */
export const L4_OPENAI_ID = 'l4-openai'
/** L4 占位项的名称 */
const L4_TITLE = 'OpenAI'
/** L4 占位项的说明 */
const L4_DESC = '在线模型'
/** 远端 API 能承接的任务：工具需要其中之一时才补 L4 占位（目前还没有 L4 实现） */
export const L4_PLACEHOLDER_TASKS: readonly AiTask[] = ['prompt', 'summarize', 'proofread', 'rewrite', 'translate']
/** 层的展示顺序 */
const LAYER_ORDER: readonly AiLayer[] = ['L1', 'L2', 'L3', 'L4']
/** 选择失效时可以自动回落的层（本地优先；L3/L4 默认不自动启用，决策 0005） */
const LOCAL_LAYERS: readonly AiLayer[] = ['L1', 'L2']

/** 任务的中文短名，拼备注用 */
export const TASK_LABELS: Record<AiTask, string> = {
  summarize: '摘要',
  proofread: '校对',
  rewrite: '改写',
  describeImage: '看图说话',
  prompt: '问答',
  translate: '翻译',
  classifyImage: '识图',
  ocr: '文字识别',
  couplet: '对联',
  matting: '抠图',
  logoSymbol: 'logo 符号',
}

/**
 * 旧选择值（清单模型 id）到新选择值（提供者 id）的一次性迁移表。值为 null 表示丢弃（让目录回落默认）。
 * 只登记原生已有提供者的模型；其余工具声明过的清单模型按规则迁成 `model:<id>`（见 {@link migrateChoice}）。
 */
export const LEGACY_CHOICE_MIGRATION: ReadonlyMap<string, string | null> = new Map<string, string | null>([
  ['siglip2-q4_half', 'local-clip'],
  ['siglip2-mnn-w8', 'local-clip'],
  ['nllb600m-un6-ccm-int4', 'local-nllb'],
  ['nllb600m-un6-mnn-w6', 'local-nllb'],
  ['qwen35-0.8b-mnn-q4', 'local-qwen'],
  // 文字识别：早期工具声明的清单占位 id 'ocr'（没有对应的真实模型），与现在的真实模型 id 都迁到提供者
  ['ocr', 'local-ocr'],
  ['ppocrv5-mnn-fp16', 'local-ocr'],
  // 早期的 L2 占位项，从来不可选
  ['l2-none', null],
])

/** 目录项状态：ready 可直接用 / missing 未下载 / loading 下载中 / unsupported 未接入 */
export type CatalogStatus = 'ready' | 'missing' | 'loading' | 'unsupported'

/** 目录的一项（选择器的一行、工具页读当前选择都用它） */
export interface CatalogItem {
  /** 选择值（持久化）：提供者 id；过渡项为 `model:<清单 id>`；占位为固定 id */
  key: string
  /** 提供者 id；过渡项与占位没有 */
  providerId?: string
  /** 清单模型 id（下载用）；不依赖本地模型的没有 */
  modelId?: string
  /** 层 */
  layer: AiLayer
  /** 模型名（不含层名） */
  title: string
  /** 作用说明 */
  desc: string
  /** 状态 */
  status: CatalogStatus
  /** 总字节（展示体积与进度） */
  totalBytes: number
  /** 已下载字节 */
  downloadedBytes: number
  /** 该工具所需任务的约束（如翻译的语言清单），来自原生报价 */
  constraints?: AiOfferConstraints
  /** 该工具所需任务各自走的入口 */
  entries: Partial<Record<AiTask, AiEntry>>
  /** 能否被选中（占位不能） */
  selectable: boolean
  /** 提供者是否持有可预热/卸载的会话（预热只对它生效）；过渡项与占位为 false */
  session: boolean
}

/** 构建目录的输入 */
export interface CatalogInput {
  /** 工具需要的任务 */
  tasks: readonly ToolAiTask[]
  /** 过渡：工具声明的 L1 清单模型 */
  models: readonly ToolModelOption[]
  /** `native.ai.providers` 的提供者（注册顺序） */
  providers: readonly AiProviderInfo[]
  /** 模型 store 的状态，按清单 id 索引 */
  statuses: Readonly<Record<string, ModelStatus | undefined>>
}

/** 规整后的任务需求 */
interface Need {
  /** 任务 */
  task: AiTask
  /** 限定入口；没有表示不限 */
  entry?: AiEntry
}

/**
 * 把工具声明的任务规整成 `{ task, entry? }`。
 *
 * @param tasks 工具声明
 * @returns 规整后的需求
 */
function normalize(tasks: readonly ToolAiTask[]): Need[] {
  return tasks.map((t) => (typeof t === 'string' ? { task: t } : t))
}

/**
 * 过渡项的选择值。
 *
 * @param modelId 清单模型 id
 * @returns `model:<id>`
 * @example modelKey('ocr') // 'model:ocr'
 */
export function modelKey(modelId: string): string {
  return MODEL_KEY_PREFIX + modelId
}

/**
 * 按报价拼备注：翻译带语言清单时写「N 种语言互译」，其余写任务短名，用「、」连接。
 *
 * @param offers 与工具需求匹配上的报价
 * @returns 如「6 种语言互译」「摘要、问答」
 */
export function describeOffers(offers: readonly AiOffer[]): string {
  return offers
    .map((o) => {
      const n = o.constraints?.languages?.length ?? 0
      return o.task === 'translate' && n > 0 ? `${n} 种语言互译` : TASK_LABELS[o.task]
    })
    .join('、')
}

/** 依赖本地模型的提供者的状态：优先读 store，store 还没拿到就用提供者自带的下载信息 */
function modelState(p: AiProviderInfo, st: ModelStatus | undefined): Pick<CatalogItem, 'status' | 'totalBytes' | 'downloadedBytes'> {
  if (st) return { status: stateToStatus(st.state), totalBytes: st.totalBytes, downloadedBytes: st.downloadedBytes }
  const size = p.sizeBytes ?? 0
  const status: CatalogStatus = p.downloaded ? 'ready' : p.downloading ? 'loading' : 'missing'
  return { status, totalBytes: size, downloadedBytes: size }
}

/**
 * 提供者是否持有可预热的会话：以原生的 `session` 为准；旧原生没有该字段时，按“依赖本地模型”兜底（当时的本地模型类提供者都有会话）。
 *
 * @param p 提供者
 * @returns 有会话为 true
 * @example hasSession({ id: 'intent-handoff', displayName: '', available: true, tasks: [], session: false }) // false
 */
export function hasSession(p: AiProviderInfo): boolean {
  return p.session ?? !!p.modelId
}

/**
 * 当前项该预热的提供者 id：只有声明了会话能力的提供者才预热，其余（交接、占位、过渡项）返回 undefined。
 *
 * @param item 当前目录项，可为空
 * @returns 提供者 id 或 undefined
 * @example sessionProviderOf(catalog.current.value) // 'local-nllb'
 */
export function sessionProviderOf(item: CatalogItem | null | undefined): string | undefined {
  return item?.session ? item.providerId : undefined
}

/**
 * 构建一个工具的 AI 目录。适用性全由原生报价决定：
 * - 系统应用交接（`HANDOFF_PROVIDER_ID`）不进目录：它只是把文本丢给第三方应用、拿不回结果，不算「本机AI」（仅指系统级端侧模型）；
 * - 提供者的报价里含工具需要的任务（入口也对得上）才出现；
 * - 依赖本地模型的提供者按下载状态给 ready/missing/loading；不依赖模型的（本机 AI）不可用就**隐藏**（决策 0005）；
 * - 工具声明的过渡清单模型：原生已有同 `modelId` 的提供者就并进去（沿用工具的文案），没有就按清单状态单独出一项；
 * - 工具需要文本类任务时补一个 L4 占位（不可选）；
 * - 按层 L1~L4 排序，同层保持注册顺序。
 *
 * @param input 工具声明、提供者、模型状态
 * @returns 目录项
 * @example
 * buildCatalog({ tasks: ['classifyImage'], models: [], providers, statuses }).map((i) => i.key) // ['local-clip']
 */
export function buildCatalog(input: CatalogInput): CatalogItem[] {
  const needs = normalize(input.tasks)
  const legacy = new Map(input.models.map((m) => [m.modelId, m] as const))
  const out: CatalogItem[] = []
  for (const p of input.providers) {
    if (p.id === HANDOFF_ID) continue
    const offers = (p.offers ?? []).filter((o) => needs.some((n) => n.task === o.task && (!n.entry || n.entry === o.entry)))
    if (!offers.length) continue
    if (!p.modelId && !p.available) continue
    const state = p.modelId ? modelState(p, input.statuses[p.modelId]) : { status: 'ready' as const, totalBytes: 0, downloadedBytes: 0 }
    const own = p.modelId ? legacy.get(p.modelId) : undefined
    if (own) legacy.delete(own.modelId)
    const entries: Partial<Record<AiTask, AiEntry>> = {}
    offers.forEach((o) => (entries[o.task] = o.entry))
    out.push({
      key: p.id,
      providerId: p.id,
      modelId: p.modelId,
      layer: p.layer ?? 'L3',
      title: own?.title ?? p.displayName,
      desc: own?.desc ?? describeOffers(offers),
      ...state,
      constraints: offers.find((o) => o.constraints)?.constraints,
      entries,
      selectable: true,
      session: hasSession(p),
    })
  }
  for (const m of legacy.values()) {
    const st = input.statuses[m.modelId]
    out.push({
      key: modelKey(m.modelId),
      modelId: m.modelId,
      layer: 'L1',
      title: m.title,
      desc: m.desc,
      status: stateToStatus(st?.state),
      totalBytes: st?.totalBytes ?? 0,
      downloadedBytes: st?.downloadedBytes ?? 0,
      entries: {},
      selectable: true,
      session: false,
    })
  }
  const wantsText = needs.some((n) => L4_PLACEHOLDER_TASKS.includes(n.task))
  if (wantsText && !out.some((i) => i.layer === 'L4')) {
    out.push({
      key: L4_OPENAI_ID,
      layer: 'L4',
      title: L4_TITLE,
      desc: L4_DESC,
      status: 'unsupported',
      totalBytes: 0,
      downloadedBytes: 0,
      entries: {},
      selectable: false,
      session: false,
    })
  }
  // Array.prototype.sort 稳定（chrome70+），同层保持注册顺序
  return out.sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer))
}

/**
 * 解析最终选中项：存的值仍是可选项就用它（旧的清单 id / `model:<id>` 能按 `modelId` 对上提供者项也算）；
 * 否则按“本地优先”回落：第一个 ready 的 L1 → 第一个 L1 → 第一个 ready 的 L2 → 第一个 L2；都没有为 null。
 * **不会自动回落到 L3/L4**：交接与远端会把内容交给第三方，决策 0005 要求默认不自动启用，只能用户自己选。
 *
 * @param stored 持久化的值（可能为空或已失效）
 * @param items 目录
 * @returns 选择值或 null
 * @example resolveChoice('gone', items) // 第一个 ready 的 L1，如 'local-nllb'
 */
export function resolveChoice(stored: string | null, items: readonly CatalogItem[]): string | null {
  const selectable = items.filter((i) => i.selectable)
  if (stored) {
    const hit = selectable.find((i) => i.key === stored)
    if (hit) return hit.key
    const bare = stored.startsWith(MODEL_KEY_PREFIX) ? stored.slice(MODEL_KEY_PREFIX.length) : stored
    const alias = selectable.find((i) => i.modelId === bare)
    if (alias) return alias.key
  }
  for (const layer of LOCAL_LAYERS) {
    const list = selectable.filter((i) => i.layer === layer)
    const pick = list.find((i) => i.status === 'ready') ?? list[0]
    if (pick) return pick.key
  }
  return null
}

/**
 * 旧选择值迁移：L1/L2 以前存清单模型 id，现在存提供者 id。先查 {@link LEGACY_CHOICE_MIGRATION}，
 * 再把工具声明过的清单模型 id 迁成 `model:<id>`；其余（已是新值、L3 提供者 id、无法识别）原样返回，交给目录回落。
 *
 * @param raw 读到的值
 * @param legacyModelIds 工具声明的过渡清单模型 id
 * @returns 新值；表里标记丢弃或没有值为 null
 * @example migrateChoice('qwen35-0.8b-mnn-q4', []) // 'local-qwen'
 * @example migrateChoice('ocr', ['ocr']) // 'local-ocr'（迁移表优先）
 * @example migrateChoice('upscale', ['upscale']) // 'model:upscale'（表里没有，按过渡清单模型处理）
 */
export function migrateChoice(raw: string | null, legacyModelIds: readonly string[]): string | null {
  if (raw == null) return null
  if (LEGACY_CHOICE_MIGRATION.has(raw)) return LEGACY_CHOICE_MIGRATION.get(raw) ?? null
  if (legacyModelIds.includes(raw)) return modelKey(raw)
  return raw
}

/**
 * 不看运行时信息的默认选择（目录还没探测到时用）：工具第一个过渡清单模型迁移后的值，没有为 null。
 *
 * @param models 工具声明的过渡清单模型
 * @returns 默认选择值
 * @example staticDefault([{ modelId: 'siglip2-mnn-w8', title: '', desc: '' }]) // 'local-clip'
 */
export function staticDefault(models: readonly ToolModelOption[]): string | null {
  const first = models[0]?.modelId
  return first ? migrateChoice(first, [first]) : null
}
