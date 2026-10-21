// AI 符号的纯逻辑：解析原生返回的 SVG path、质量闸门排序与补位、逐张生成（可取消、并发拒绝重试）、候选 → logo 参数。页面只负责接线。

import type { LogoSymbolResult } from '@/native/ai'
import { paramsFromPlan, type LogoInput } from './logic'
import type { LogoPlan } from './plan'
import { SYMBOL_LAYOUTS } from './symbolScene'
import type { AiSymbol, LogoParams, SymbolLayoutId, SymbolPath } from './types'

/** 原生符号坐标系边长 */
export const SYMBOL_VB = 512
/** 一个符号最多接受多少条 path（防异常数据拖垮渲染） */
export const MAX_SYMBOL_PATHS = 400
/** 所有 path 的 d 总长度上限（字符） */
export const MAX_SYMBOL_D_CHARS = 400_000
/** “正在生成，请稍候”被拒后最多重试几次 */
export const BUSY_RETRY_MAX = 12
/** 被拒后每次重试前的等待毫秒（取消后原生还要收尾，最长约一次 UNet） */
export const BUSY_RETRY_MS = 1500
/** 随机种子上限（原生接受 0~2^53-1，取 2^31 足够且保证是安全整数） */
const SEED_LIMIT = 2 ** 31
/** 原生并发拒绝信息里的关键字 */
const BUSY_KEYWORD = '正在生成'
/** 原生取消的错误码（与 native/ai.ts 的 isAiCancelled 同一判据；这里不直接引用，免得纯逻辑模块拉进依赖 window 的桥） */
const CODE_CANCELLED = 'CANCELLED'
/** 浏览器取消的错误名 */
const NAME_ABORT = 'AbortError'
/** 未过闸的提示文案 */
export const GATE_WARN_TEXT = '效果可能欠佳'
/** path 片段 */
const RE_PATH_TAG = /<path\b[^>]*\/>/g
/** 取 d 属性 */
const RE_ATTR_D = /\sd="([^"]*)"/
/** 取 translate(x,y) 平移 */
const RE_TRANSLATE = /transform="translate\(\s*([-+]?[\d.]+(?:e[-+]?\d+)?)[\s,]+([-+]?[\d.]+(?:e[-+]?\d+)?)\s*\)"/i
/** d 只允许路径命令、数字与分隔符（预览用 v-html，不放行任何其它字符） */
const RE_D_SAFE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/

/** 闸门原因码 → 中文 */
const GATE_REASON_TEXT: Record<string, string> = {
  empty: '没画出图形',
  ink_low: '图形太淡',
  ink_high: '图形太满',
  concentric: '像同心圆靶',
  fragments: '图形太碎',
  specks: '杂点太多',
  small: '图形太小',
  off_center: '偏离中心',
}

/** 一张生成结果（已解析） */
export interface SymbolCandidate {
  /** 概念词（英文物体） */
  concept: string
  /** 本次种子 */
  seed: number
  /** 是否过质量闸门 */
  gateOk: boolean
  /** 未过的原因码 */
  reasons: string[]
  /** 解析后的路径 */
  paths: SymbolPath[]
  /** 原生总耗时毫秒 */
  elapsedMs: number
}

/**
 * 解析原生返回的 `<path .../>` 片段：取 d 与平移；d 含非法字符的整条丢弃；条数与总长度有上限。
 *
 * @param svg 原生的 svgPaths，空图为 null
 * @returns 路径列表（可能为空）
 * @example parseSymbolPaths('<path d="M0 0 L10 10 Z" fill="#000000" transform="translate(5,6)"/>') // [{ d, tx: 5, ty: 6 }]
 */
export function parseSymbolPaths(svg: string | null | undefined): SymbolPath[] {
  if (!svg) return []
  const out: SymbolPath[] = []
  let total = 0
  for (const tag of svg.match(RE_PATH_TAG) ?? []) {
    if (out.length >= MAX_SYMBOL_PATHS) break
    const d = RE_ATTR_D.exec(tag)?.[1]?.trim()
    if (!d || !RE_D_SAFE.test(d)) continue
    total += d.length
    if (total > MAX_SYMBOL_D_CHARS) break
    const t = RE_TRANSLATE.exec(tag)
    const tx = t ? Number(t[1]) : 0
    const ty = t ? Number(t[2]) : 0
    out.push({ d, tx: Number.isFinite(tx) ? tx : 0, ty: Number.isFinite(ty) ? ty : 0 })
  }
  return out
}

/**
 * 原生结果 → 候选；没有可用路径（空图）返回 null，不展示。
 *
 * @param concept 概念词
 * @param r 原生结果
 * @returns 候选或 null
 * @example toCandidate('a dumbbell', result)
 */
export function toCandidate(concept: string, r: LogoSymbolResult): SymbolCandidate | null {
  const paths = parseSymbolPaths(r.svgPaths)
  if (!paths.length) return null
  return { concept, seed: r.seed, gateOk: !!r.gateOk, reasons: (r.gateReasons ?? []).map(String), paths, elapsedMs: r.elapsedMs }
}

/**
 * 闸门排序：过闸的在前，各组内保持生成顺序（稳定）。
 *
 * @param list 候选（按生成顺序）
 * @returns 新数组，不改入参
 * @example sortCandidates([bad, good]) // [good, bad]
 */
export function sortCandidates(list: readonly SymbolCandidate[]): SymbolCandidate[] {
  return [...list.filter((c) => c.gateOk), ...list.filter((c) => !c.gateOk)]
}

/**
 * 是否要补上模板方案：一张过闸的都没有（含一张都没出）。
 *
 * @param list 候选
 * @returns true 表示需要补位
 * @example needTemplateFallback([]) // true
 */
export function needTemplateFallback(list: readonly SymbolCandidate[]): boolean {
  return !list.some((c) => c.gateOk)
}

/**
 * 未过闸原因的中文摘要，如“图形太碎、杂点太多”；未知原因码原样保留。
 *
 * @param reasons 原因码
 * @returns 中文摘要；没有原因为空串
 * @example reasonText(['fragments', 'specks']) // '图形太碎、杂点太多'
 */
export function reasonText(reasons: readonly string[]): string {
  return reasons.map((r) => GATE_REASON_TEXT[r] ?? r).join('、')
}

/**
 * 第 i 张用的版式：四种轮流。
 *
 * @param i 从 0 开始的序号
 * @returns 版式 id
 * @example layoutAt(5) // 'ai-solid'
 */
export function layoutAt(i: number): SymbolLayoutId {
  return SYMBOL_LAYOUTS[((i % SYMBOL_LAYOUTS.length) + SYMBOL_LAYOUTS.length) % SYMBOL_LAYOUTS.length].id
}

/**
 * 候选 → 完整 logo 参数：配色与字体取自关键词方案 plan，版式按序号轮流。
 *
 * @param c 候选
 * @param plan 提供配色、字体的方案（来自 planByKeywords）
 * @param input 页面输入
 * @param index 序号（决定版式）
 * @returns 带 symbol 的参数
 * @example paramsFromSymbol(cand, plans[0], { name: 'A', slogan: '', desc: '' }, 0)
 */
export function paramsFromSymbol(c: SymbolCandidate, plan: LogoPlan, input: LogoInput, index: number): LogoParams {
  const symbol: AiSymbol = { layout: layoutAt(index), vb: SYMBOL_VB, paths: c.paths }
  return { ...paramsFromPlan(plan, input), icon: '', symbol }
}

/** 第几张进度文案 */
export function progressText(done: number, total: number): string {
  return `第 ${Math.min(done + 1, total)}/${total} 张`
}

/**
 * 是不是原生“正在生成，请稍候”的并发拒绝（取消后原生还在收尾时会遇到）。
 *
 * @param e 错误
 * @returns 是则为 true
 * @example isBusyError({ code: 'INTERNAL', message: '正在生成，请稍候' }) // true
 */
export function isBusyError(e: unknown): boolean {
  const m = (e as { message?: unknown } | null)?.message
  return typeof m === 'string' && m.includes(BUSY_KEYWORD)
}

/** 是不是取消类错误 */
function isCancelled(e: unknown): boolean {
  const x = e as { code?: string; name?: string } | null
  return x?.code === CODE_CANCELLED || x?.name === NAME_ABORT
}

/** 随机种子 */
export function randomSeed(): number {
  return Math.floor(Math.random() * SEED_LIMIT)
}

/** 单次生成函数：提示词与种子进，原生结果出 */
export type GenerateOne = (concept: string, seed: number, signal: AbortSignal | undefined) => Promise<LogoSymbolResult>

/** 批量生成的选项 */
export interface BatchOptions {
  /** 取消信号 */
  signal?: AbortSignal
  /** 每张开始前回调：已完成张数、总张数 */
  onProgress?: (done: number, total: number) => void
  /** 每出一张（含空图，此时 candidate 为 null）回调 */
  onItem?: (candidate: SymbolCandidate | null, index: number) => void
  /** 被原生“正在生成”拒绝、即将等待重试时回调（取消后原生还在收尾），参数为已重试次数 */
  onBusy?: (retries: number) => void
  /** 种子来源（测试注入） */
  seed?: () => number
  /** 等待函数（测试注入） */
  sleep?: (ms: number) => Promise<void>
}

/** 批量生成的结果 */
export interface BatchResult {
  /** 已出的候选（按生成顺序，不含空图） */
  items: SymbolCandidate[]
  /** 是否被取消（已出的保留） */
  cancelled: boolean
  /** 非取消错误（出错即停止后续张；已出的保留） */
  error?: unknown
}

/** 默认等待 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 按概念依次生成：一张出一张；取消后不再发起后续张、已出的保留；遇到并发拒绝等一会儿重试；其它错误停止并带回。
 *
 * @param concepts 概念词（英文物体），按顺序生成
 * @param gen 单次生成函数
 * @param opts 取消、进度、逐张回调
 * @returns 已出的候选与结束原因
 * @example const r = await runSymbolBatch(['a cup', 'a bean'], gen, { signal, onItem: (c) => list.push(c) })
 */
export async function runSymbolBatch(concepts: readonly string[], gen: GenerateOne, opts: BatchOptions = {}): Promise<BatchResult> {
  const { signal, onProgress, onItem, onBusy, seed = randomSeed, sleep = defaultSleep } = opts
  const items: SymbolCandidate[] = []
  for (let i = 0; i < concepts.length; i++) {
    if (signal?.aborted) return { items, cancelled: true }
    onProgress?.(i, concepts.length)
    let res: LogoSymbolResult | null = null
    for (let tries = 0; res === null; tries++) {
      try {
        res = await gen(concepts[i], seed(), signal)
      } catch (e) {
        if (isCancelled(e) || signal?.aborted) return { items, cancelled: true }
        if (!isBusyError(e) || tries >= BUSY_RETRY_MAX) return { items, cancelled: false, error: e }
        onBusy?.(tries + 1)
        await sleep(BUSY_RETRY_MS)
        if (signal?.aborted) return { items, cancelled: true }
      }
    }
    const cand = toCandidate(concepts[i], res)
    if (cand) items.push(cand)
    onItem?.(cand, i)
  }
  return { items, cancelled: false }
}
