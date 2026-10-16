// 垃圾分类识别的页面逻辑：分类展示、结果整理、易混提示、模型就绪阶段与错误文案（全部纯函数）
import type { ImageClassifyItem, ImageClassifyResult } from '@/native/ai'
import type { ModelStateName } from '@/native/model'

/** 识别用的模型 id（对应原生清单） */
export const MODEL_ID = 'siglip2-mnn-w8'
/** 每次请求的候选条数 */
export const TOP_K = 3
/** 连续识别超过这个次数提示歇一会儿 */
export const HEAT_TIP_COUNT = 20
/** 识别超过这个毫秒数还没出结果，提示可能在排队 */
export const QUEUE_HINT_MS = 3000
/** 单次最多展示的易混提示条数 */
export const MAX_HINTS = 2
/** 分数条的最小宽度百分比，保证再低的候选也看得见 */
const MIN_BAR_PERCENT = 4
/** 提示表至少命中几个 id 才算「易混」 */
const MIN_HINT_MATCH = 2

/** 页面底部固定的免责小字 */
export const DISCLAIMER = '分类依据上海标准，仍在核对中，仅供参考，以当地规定为准。'
/** 拿不准时顶部的话 */
export const UNCERTAIN_TEXT = '拿不准，请从下面选一个更像的'
/** 热提示文案 */
export const HEAT_TEXT = '手机有点热了，歇一会儿再拍更快'
/** 图片解码失败文案 */
export const BAD_IMAGE_TEXT = '这张图读不出来，换一张试试'
/** 非宿主提示 */
export const NO_HOST_TEXT = '请在 App 中使用'

/** 分类展示信息 */
export interface CategoryMeta {
  /** 分类代码 */
  code: string
  /** 中文名 */
  name: string
  /** 图标（emoji） */
  icon: string
  /** 主题色 CSS 变量名，定义在 styles/index.scss（含深色） */
  colorVar: string
}

/** 四个分类的展示信息，颜色全走主题 token */
export const CATEGORY_META: Record<string, CategoryMeta> = {
  R: { code: 'R', name: '可回收物', icon: '♻️', colorVar: '--c-waste-r' },
  H: { code: 'H', name: '有害垃圾', icon: '☠️', colorVar: '--c-waste-h' },
  W: { code: 'W', name: '湿垃圾', icon: '🥬', colorVar: '--c-waste-w' },
  D: { code: 'D', name: '干垃圾', icon: '🗑️', colorVar: '--c-waste-d' },
}

/** 未知分类的兜底 */
const UNKNOWN_META: CategoryMeta = { code: '?', name: '未知分类', icon: '❔', colorVar: '--c-text-muted' }

/**
 * 取分类展示信息，未知代码给兜底。
 *
 * @param code 分类代码 R/H/W/D
 * @returns 展示信息
 * @example categoryMeta('H').name // '有害垃圾'
 */
export function categoryMeta(code: string): CategoryMeta {
  return CATEGORY_META[code] ?? UNKNOWN_META
}

/**
 * 概率转整数百分比文案，越界夹紧。
 *
 * @param p 0~1 的概率
 * @returns 如 `87%`
 * @example percentText(0.874) // '87%'
 */
export function percentText(p: number): string {
  const v = Math.min(1, Math.max(0, isFinite(p) ? p : 0))
  return `${Math.round(v * 100)}%`
}

/** 一张候选物品卡 */
export interface CandidateCard {
  /** 词表 id */
  id: string
  /** 中文名 */
  nameZh: string
  /** 英文名 */
  nameEn: string
  /** 所属分类展示信息 */
  category: CategoryMeta
  /** 分数条宽度 0~100（相对第一名） */
  bar: number
  /** 是否被采纳 */
  selected: boolean
}

/** 顶部大字区域 */
export interface Headline {
  /** pending：没有结论（拿不准且用户还没选）；done：有结论 */
  kind: 'pending' | 'done'
  /** 主文案：分类名或「拿不准…」 */
  title: string
  /** 分类展示信息，pending 时为 null */
  category: CategoryMeta | null
  /** 副文案：置信度或「按你选的」 */
  sub: string
}

/** 整理后的结果视图 */
export interface ResultView {
  /** 顶部大字 */
  headline: Headline
  /** 候选卡片 */
  cards: CandidateCard[]
}

/**
 * 默认该选中哪个候选：拿得准默认第一个，拿不准不预选（-1）。
 *
 * @param r 识别结果
 * @returns 下标或 -1
 * @example defaultSelection({ uncertain: true, items: [] }) // -1
 */
export function defaultSelection(r: Pick<ImageClassifyResult, 'uncertain' | 'items'>): number {
  return r.uncertain || !r.items.length ? -1 : 0
}

/**
 * 把原生结果和当前选中项整理成页面视图。用户点哪个候选，顶部分类就跟着变成那个物品的分类。
 *
 * @param r 识别结果
 * @param selected 选中的候选下标，-1 表示没选
 * @returns 顶部大字与候选卡片
 * @example buildView(result, 0).headline.title // '可回收物'
 */
export function buildView(r: ImageClassifyResult, selected: number): ResultView {
  const items = r.items ?? []
  const top = items[0]?.score ?? 0
  const cards = items.map<CandidateCard>((it, i) => ({
    id: it.id,
    nameZh: it.nameZh,
    nameEn: it.nameEn,
    category: categoryMeta(it.category),
    bar: top > 0 ? Math.max(MIN_BAR_PERCENT, Math.min(100, Math.round((it.score / top) * 100))) : MIN_BAR_PERCENT,
    selected: i === selected,
  }))
  const pick = items[selected]
  if (!pick) {
    return {
      headline: { kind: 'pending', title: r.uncertain ? UNCERTAIN_TEXT : '没认出来，换个角度再试试', category: null, sub: '' },
      cards,
    }
  }
  const meta = categoryMeta(pick.category)
  const agg = r.categories?.find((c) => c.category === pick.category)
  const isModelTop = selected === 0 && !r.uncertain
  const sub = isModelTop
    ? `把握 ${percentText(r.confidence)}`
    : agg
      ? `按你选的「${pick.nameZh}」，模型给这一类 ${percentText(agg.prob)}`
      : `按你选的「${pick.nameZh}」`
  return { headline: { kind: 'done', title: meta.name, category: meta, sub }, cards }
}

/** 易混提示：一组容易搞混的词表 id 与一句人话 */
export interface ConfusableHint {
  /** 词表 id 集合，top-3 里命中其中至少两个就提示 */
  ids: string[]
  /** 提示文案 */
  text: string
}

/** 本地易混提示表（id 已与 garbage_vocab.json 核对，测试里会再校验一次） */
export const CONFUSABLE_HINTS: ConfusableHint[] = [
  {
    ids: ['clean_cardboard_box', 'greasy_takeout_food_container', 'dirty_stained_paper', 'packaging_paper_box'],
    text: '纸盒沾了油污就按干垃圾，干净的才算可回收物。',
  },
  {
    ids: ['clean_plastic_food_container', 'greasy_takeout_food_container', 'styrofoam_food_box'],
    text: '外卖餐盒：洗干净的塑料盒可以回收，沾油的、泡沫的按干垃圾。',
  },
  {
    ids: ['used_tissue_paper', 'toilet_paper', 'wet_wipes', 'clean_paper_sheet', 'printer_paper'],
    text: '用过的纸巾、卫生纸、湿纸巾都是干垃圾，只有干净的纸张才算可回收物。',
  },
  {
    ids: ['aa_alkaline_battery', 'button_cell_battery', 'rechargeable_battery', 'lithium_ion_battery', 'lead_acid_battery'],
    text: '各种电池长得像，但都按有害垃圾单独投放，别丢进普通垃圾桶。',
  },
  {
    ids: ['large_bone', 'small_bones', 'fish_bones'],
    text: '大骨头是干垃圾，小骨头、鱼骨才是湿垃圾。',
  },
  {
    ids: ['ceramic_mug', 'ceramic_bowl', 'broken_ceramic_pieces', 'mirror', 'drinking_glass', 'glass_bottle', 'glass_jar', 'broken_glass_shards'],
    text: '陶瓷和镜子是干垃圾，玻璃瓶罐、玻璃杯才算可回收物。',
  },
]

/**
 * 找 top 候选里命中的易混提示：同一组里至少出现两个 id 才提示，最多 {@link MAX_HINTS} 条。
 *
 * @param items 候选物品（通常是 top-3）
 * @param table 提示表，默认 {@link CONFUSABLE_HINTS}（仅测试注入）
 * @returns 提示文案列表
 * @example matchHints(result.items).forEach(showTip)
 */
export function matchHints(items: Array<Pick<ImageClassifyItem, 'id'>>, table: ConfusableHint[] = CONFUSABLE_HINTS): string[] {
  const present = new Set(items.map((i) => i.id))
  const out: string[] = []
  for (const h of table) {
    if (h.ids.filter((id) => present.has(id)).length >= MIN_HINT_MATCH) out.push(h.text)
    if (out.length >= MAX_HINTS) break
  }
  return out
}

/** 页面阶段：模型的下载与管理归 AI 中心，本页只区分能不能用 */
export type Stage = 'noHost' | 'notReady' | 'ready'

/**
 * 把宿主与模型状态映射成页面阶段；只有已安装才算就绪，其余一律「未就绪」。
 * 状态由 store 实时推送，没有「探测中」这一档。
 *
 * @param host 是否在 App 容器内
 * @param state 模型状态名
 * @returns 页面阶段
 * @example stageOf(true, 'installed') // 'ready'
 */
export function stageOf(host: boolean, state: ModelStateName): Stage {
  if (!host) return 'noHost'
  return state === 'installed' ? 'ready' : 'notReady'
}

/** 识别失败的归类 */
export interface ClassifyFailure {
  /** notReady 回到未就绪提示；toast 只提示 */
  kind: 'notReady' | 'toast'
  /** 提示文案 */
  text: string
}

/**
 * 识别失败归类：NOT_READY 回未就绪提示；INTERNAL 一般是图片读不出来；其余给通用话。
 *
 * @param e 捕获的错误（AiNotReadyError 或带 code 的原生错误）
 * @returns 归类与文案
 * @example classifyFailure({ code: 'INTERNAL' }).text // '这张图读不出来，换一张试试'
 */
export function classifyFailure(e: unknown): ClassifyFailure {
  const o = e as { name?: string; code?: string } | null
  if (o?.name === 'AiNotReadyError' || o?.code === 'NOT_READY') return { kind: 'notReady', text: '识别模型还没准备好，请先下载模型。' }
  if (o?.code === 'BAD_PARAMS') return { kind: 'toast', text: '这张图没法识别，换一张试试' }
  if (o?.code === 'INTERNAL') return { kind: 'toast', text: BAD_IMAGE_TEXT }
  return { kind: 'toast', text: '识别没成功，稍后再试' }
}

/**
 * 识别中的提示文案：久了就说一下可能在排队。
 *
 * @param elapsedMs 已等待毫秒
 * @returns 提示
 * @example busyText(5000)
 */
export function busyText(elapsedMs: number): string {
  return elapsedMs >= QUEUE_HINT_MS ? '还在算，前面可能有别的 AI 任务在排队，稍等一下' : '正在看这是什么…'
}

/**
 * 连续识别次数是否该提示「歇一会儿」。
 *
 * @param count 本页已识别次数
 * @returns 超过 {@link HEAT_TIP_COUNT} 为 true
 * @example shouldWarnHeat(21) // true
 */
export function shouldWarnHeat(count: number): boolean {
  return count > HEAT_TIP_COUNT
}
