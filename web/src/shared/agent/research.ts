// 端侧「联网调研」原型：小模型只在 2 个固定节点出场（拆问题 / 总结资料），流程由代码掌控
import { aiInvoke } from '@/native/ai'
import { webSearch, type SearchHit } from './search'

export type { SearchHit }

/** 调研流程依赖的外部能力（全部可注入，便于单测） */
export interface ResearchDeps {
  /** 调本地模型：system + prompt → 文本 */
  generate: (system: string, prompt: string, signal?: AbortSignal) => Promise<string>
  /** 联网搜索：关键词 → 结果（按相关度排序） */
  search: (query: string, signal?: AbortSignal) => Promise<SearchHit[]>
}

/** 调研预算，默认值按「预填约 35 tok/s」定：资料越长，首字越慢 */
export interface ResearchBudget {
  /** 子问题个数上限 */
  maxSubQueries: number
  /** 所有资料合计字符上限（约 1.4 字/token，1200 字预填约 25 秒） */
  evidenceChars: number
  /** 资料条数上限 */
  maxSources: number
}

/** 调研进度事件，页面据此显示「拆问题 → 搜索 → 回答」 */
export type ResearchEvent =
  | { stage: 'plan' }
  | { stage: 'search'; queries: string[] }
  | { stage: 'answer'; sources: number }

/** 调研结果 */
export interface ResearchResult {
  /** 最终回答（带 [编号] 引用） */
  answer: string
  /** 实际搜索的子问题 */
  queries: string[]
  /** 参与回答的资料，编号对应回答里的 [n] */
  sources: SearchHit[]
}

/** 默认预算 */
export const DEFAULT_BUDGET: ResearchBudget = { maxSubQueries: 3, evidenceChars: 1200, maxSources: 4 }
/** 子问题最短长度，过短的多半是模型胡写 */
const QUERY_MIN = 2
/** 子问题最长长度，过长的多半不是关键词 */
const QUERY_MAX = 40
/** 没搜到资料时的回答（不再调模型，省 25 秒） */
export const NO_RESULT_ANSWER = '没有搜到相关资料，换个说法再试试。'
/** 拆问题的 system 提示：只要求逐行输出关键词，格式越简单小模型越稳 */
const PLAN_SYSTEM = '你是搜索助手。把用户的问题拆成最多{n}个互不重复的搜索关键词，每行一个，只输出关键词，不要解释，不要编号。'
/** 回答的 system 提示：只许依据资料，并要求标注来源编号 */
const ANSWER_SYSTEM =
  '你是研究助手。只根据【资料】回答问题，用中文，简洁，每个结论后标注来源编号如[1]。资料里没有答案就直说不知道，不要编造。'
/** 模型输出里的行首序号、项目符号与引号 */
const LINE_NOISE = /^[\s\-*•·\d.、)）(（]+|["'“”‘’「」]/g
/** 中日韩字符判断 */
const CJK = /[㐀-鿿]/

/**
 * 解析模型拆出的子问题：逐行清理序号与符号，去重，长度越界的丢掉；一个都没有就退回原问题。
 *
 * @param raw 模型原始输出
 * @param question 用户原问题（兜底）
 * @param max 个数上限
 * @returns 至少一个、至多 max 个关键词
 * @example parseSubQueries('1. 量子计算\n2. 量子计算 应用', '量子计算是什么', 3)
 */
export function parseSubQueries(raw: string, question: string, max: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const q = line.replace(LINE_NOISE, '').trim()
    if (q.length < QUERY_MIN || q.length > QUERY_MAX || seen.has(q)) continue
    seen.add(q)
    out.push(q)
    if (out.length >= max) break
  }
  return out.length ? out : [question.trim()]
}

/** 把关键词拆成匹配用的词项：中文单字、其它按空白分词（小写） */
function termsOf(query: string): string[] {
  const out: string[] = []
  for (const w of query.toLowerCase().split(/\s+/)) {
    if (!w) continue
    if (CJK.test(w)) {
      for (const ch of w) if (CJK.test(ch)) out.push(ch)
    } else {
      out.push(w)
    }
  }
  return [...new Set(out)]
}

/**
 * 把一段文本切成句子级片段，按与关键词的重合度挑最相关的几段，拼回原顺序且不超过字数上限。
 * 中文按单字、英文按单词计重合；没有任何重合时取开头（维基导语开头通常就是定义）。
 *
 * @param text 资料全文
 * @param query 关键词
 * @param maxChars 字数上限
 * @returns 精选片段
 * @example selectPassage(longText, '量子 计算', 300)
 */
export function selectPassage(text: string, query: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxChars) return clean
  const terms = termsOf(query)
  const parts = clean.split(/(?<=[。！？!?.；;])\s*/).filter(Boolean)
  const scored = parts.map((p, i) => ({ p, i, s: terms.filter((t) => p.toLowerCase().includes(t)).length }))
  const order = scored.some((x) => x.s > 0) ? [...scored].sort((a, b) => b.s - a.s || a.i - b.i) : scored
  const picked = new Set<number>()
  let used = 0
  for (const x of order) {
    if (used + x.p.length > maxChars) continue
    picked.add(x.i)
    used += x.p.length
  }
  if (!picked.size) return clean.slice(0, maxChars)
  return scored.filter((x) => picked.has(x.i)).map((x) => x.p).join('')
}

/**
 * 合并多个子问题的搜索结果：按网址去重，轮流各取一条（保证每个子问题都有代表），截到条数上限。
 *
 * @param groups 每个子问题的结果列表
 * @param max 条数上限
 * @returns 去重后的结果
 * @example mergeHits([[a, b], [a, c]], 3) // a b c
 */
export function mergeHits(groups: SearchHit[][], max: number): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (let round = 0; out.length < max; round++) {
    let any = false
    for (const g of groups) {
      const h = g[round]
      if (!h) continue
      any = true
      if (seen.has(h.url) || out.length >= max) continue
      seen.add(h.url)
      out.push(h)
    }
    if (!any) break
  }
  return out
}

/**
 * 拼回答用的提示词：编号资料 + 问题。每条资料的字数按预算均分。
 *
 * @param question 用户问题
 * @param hits 资料
 * @param queries 子问题（用来挑片段）
 * @param evidenceChars 资料总字数上限
 * @returns 提示词
 */
export function buildAnswerPrompt(question: string, hits: SearchHit[], queries: string[], evidenceChars: number): string {
  const each = Math.floor(evidenceChars / Math.max(hits.length, 1))
  const q = queries.join(' ')
  const lines = hits.map((h, i) => `[${i + 1}] ${h.title}：${selectPassage(h.text, q, each)}`)
  return `【资料】\n${lines.join('\n')}\n\n【问题】${question}`
}

/**
 * 跑一次调研：拆问题（模型）→ 并行搜索（代码）→ 挑片段拼资料（代码）→ 带引用回答（模型）。
 * 没搜到资料直接返回固定回答，不再调模型。被取消时抛出，调用方按 CANCELLED 处理。
 *
 * @param question 用户问题
 * @param deps 模型与搜索
 * @param onEvent 进度回调，可选
 * @param signal 取消信号，可选
 * @param budget 预算，缺省 {@link DEFAULT_BUDGET}
 * @returns 回答、子问题与资料
 * @example const r = await runResearch('量子计算有什么用', createNativeDeps())
 */
export async function runResearch(
  question: string,
  deps: ResearchDeps,
  onEvent?: (e: ResearchEvent) => void,
  signal?: AbortSignal,
  budget: ResearchBudget = DEFAULT_BUDGET,
): Promise<ResearchResult> {
  onEvent?.({ stage: 'plan' })
  const raw = await deps.generate(PLAN_SYSTEM.replace('{n}', String(budget.maxSubQueries)), question, signal)
  const queries = parseSubQueries(raw, question, budget.maxSubQueries)

  onEvent?.({ stage: 'search', queries })
  // 单个搜索失败不拖垮整体：当作该子问题没结果
  const groups = await Promise.all(queries.map((q) => deps.search(q, signal).catch(() => [] as SearchHit[])))
  signal?.throwIfAborted()
  const sources = mergeHits(groups, budget.maxSources)
  if (!sources.length) return { answer: NO_RESULT_ANSWER, queries, sources }

  onEvent?.({ stage: 'answer', sources: sources.length })
  const prompt = buildAnswerPrompt(question, sources, queries, budget.evidenceChars)
  const answer = (await deps.generate(ANSWER_SYSTEM, prompt, signal)).trim()
  return { answer, queries, sources }
}

/**
 * 用本机能力组装默认依赖：本地 Qwen（`prompt` 预设、贪心）+ 通用网页搜索（Brave，失败退维基）。
 *
 * @param provider 模型提供者 id，默认 `local-qwen`
 * @returns 可直接交给 {@link runResearch} 的依赖
 * @example await runResearch(q, createNativeDeps())
 */
export function createNativeDeps(provider = 'local-qwen'): ResearchDeps {
  return {
    generate: async (system, prompt, signal) => {
      const r = await aiInvoke('prompt', { text: prompt }, { provider, options: { preset: 'prompt', system, temperature: 0 }, signal })
      return r.text ?? ''
    },
    search: (query, signal) => webSearch(query, signal),
  }
}
