// 大模型写对联：拼提示词、解析输出、校验（等长、横批字数）、不合格重试一次。纯函数，调用模型的部分由调用方注入。

/** 横批字数下限 */
export const BANNER_MIN = 2
/** 横批字数上限 */
export const BANNER_MAX = 7
/** 横批默认字数 */
export const BANNER_DEFAULT = 4
/** 单联汉字数下限 */
export const LINE_MIN = 2
/** 单联汉字数上限（小模型写太长必然跑偏，超了直接判不合格） */
export const LINE_MAX = 20
/** 最多尝试几次（首次加一次重试） */
export const MAX_ATTEMPTS = 2
/** 用户要求留空时给模型的话 */
const FREE_STYLE = '不限，自由发挥，常见吉祥或应景内容即可'
/** 对联里允许出现的标点（与原生对联输入一致） */
const PUNCT = '，。、；：！？,.;:!?'

/** 挽联的类型名（白底黑字、不贴福字，随机语料池与大模型类型共用） */
export const MOURNING_CATEGORY = '挽联'

/** 默认类型名（不限主题；类型表里排第一） */
export const DEFAULT_CATEGORY = '通用'

/** 类型：名字与给模型看的一句话说明（定义同 scripts/couplet/README.md 的 16 类） */
export const CATEGORY_HINTS: ReadonlyArray<{ name: string; hint: string }> = [
  { name: DEFAULT_CATEGORY, hint: '不限主题' },
  { name: '春节', hint: '春联，新年、除夕、迎春纳福' },
  { name: '节庆', hint: '春节以外的节日：元宵、清明、端午、七夕、中秋、重阳、国庆等' },
  { name: '婚庆', hint: '新婚嫁娶、良缘佳偶' },
  { name: '祝寿', hint: '寿辰、生日、长寿康宁' },
  { name: '乔迁', hint: '乔迁新居、新宅落成' },
  { name: '开业', hint: '开业开张、生意兴隆、招财进宝' },
  { name: '学业', hint: '读书求学、师生、考试金榜' },
  { name: '事业', hint: '奋斗励志、创业建功、前程远大' },
  { name: '家国', hint: '爱国报国、时代发展、民生' },
  { name: '山水', hint: '写景咏物：山川风光、四季花鸟' },
  { name: '人生', hint: '人生感悟、处世修身、哲理' },
  { name: '情感', hint: '爱情相思、亲情友情、思乡怀人' },
  { name: '文墨', hint: '诗词书画琴棋茶酒、文人雅趣' },
  { name: '怀古', hint: '咏史怀古、历史人物典故、古迹' },
  { name: MOURNING_CATEGORY, hint: '哀悼逝者、追思先人，语气庄重肃穆' },
]

/** 一次生成的请求 */
export interface LlmRequest {
  /** 用户的要求，可空 */
  demand: string
  /** 要不要横批 */
  wantBanner: boolean
  /** 横批字数 2~7，仅 wantBanner 时有意义 */
  bannerLen: number
  /** 类型名，取 {@link CATEGORY_HINTS} 的 name */
  category: string
}

/** 一副对联 */
export interface Couplet {
  /** 上联 */
  up: string
  /** 下联 */
  down: string
  /** 横批，没有为空串 */
  banner: string
}

/** 生成结果：成功给对联，失败给原因与模型最后一次的原文 */
export type GenerateResult =
  | { ok: true; couplet: Couplet; attempts: number }
  | { ok: false; reason: string; raw: string; attempts: number }

/**
 * 汉字个数（标点、空白不算）。
 *
 * @param s 文本
 * @returns 汉字数
 * @example hanCount('春风，送暖') // 4
 */
export function hanCount(s: string): number {
  return (s.match(/\p{Script=Han}/gu) ?? []).length
}

/**
 * 拼给模型的提示词。
 *
 * @param req 请求
 * @param lastIssue 上一次不合格的原因；给了就在末尾追加纠正要求
 * @returns 提示词文本
 * @example buildPrompt({ demand: '程序员加班', wantBanner: true, bannerLen: 4, category: '通用' })
 */
export function buildPrompt(req: LlmRequest, lastIssue?: string): string {
  const cat = CATEGORY_HINTS.find((c) => c.name === req.category) ?? CATEGORY_HINTS[0]
  const demand = req.demand.trim() || FREE_STYLE
  const fmt = ['上联：……', '下联：……']
  if (req.wantBanner) fmt.push(`横批：……（正好 ${req.bannerLen} 个汉字）`)
  const lines = [
    '请你写一副对联。',
    `用户要求：${demand}`,
    `类型：${cat.name}（${cat.hint}）`,
    '规则：上联与下联汉字数必须完全相同，标点位置也相同；对仗工整，词性相对，上联末字仄声、下联末字平声；不要照抄用户的话；只用汉字和逗号句号。',
    '输出格式（只输出这几行，不要解释，不要加序号）：',
    ...fmt,
  ]
  if (!req.wantBanner) lines.push('不要写横批。')
  if (lastIssue) lines.push(`上一次的问题：${lastIssue}。这次请严格按规则重写。`)
  return lines.join('\n')
}

/** 引号、括号等包裹用的装饰字符 */
const DECOR = /^[\s"'“”‘’「」『』《》【】[\]()（）]+|[\s"'“”‘’「」『』《》【】[\]()（）]+$/g

/** 去掉星号、引号括号等装饰与句末句号（句号可能在引号外面，所以先后各清一遍） */
function cleanValue(v: string): string {
  return v
    .replace(/[*`#]/g, '')
    .replace(DECOR, '')
    .replace(/[。.]+$/, '')
    .replace(DECOR, '')
    .trim()
}

/**
 * 从模型输出里取上联、下联、横批（每项取第一次出现的；没有的为空串）。
 *
 * @param text 模型原文
 * @returns 三项原文
 * @example parseReply('上联：春风送暖\n下联：瑞雪兆丰\n横批：万象更新')
 */
export function parseReply(text: string): Couplet {
  const out: Couplet = { up: '', down: '', banner: '' }
  const keys: Record<string, keyof Couplet> = { 上联: 'up', 下联: 'down', 横批: 'banner' }
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/^[\s\-*>•\d.、)）]+/, '').replace(/[*`]/g, '').match(/^(上联|下联|横批)\s*[:：]\s*(.+)$/)
    if (!m) continue
    const k = keys[m[1]]
    if (!out[k]) out[k] = cleanValue(m[2])
  }
  return out
}

/** 按标点切成段，返回每段汉字数（空段丢弃） */
function segmentLengths(s: string): number[] {
  return s
    .split(new RegExp(`[${PUNCT.replace(/[\]\^-]/g, '\$&')}\s]+`))
    .filter(Boolean)
    .map((x) => [...x].length)
}

/**
 * 校验解析结果。
 *
 * @param c 解析出的对联
 * @param req 请求（决定横批要不要、几个字）
 * @returns 不合格的原因；合格返回 null
 * @example validateReply({ up: '春风送暖', down: '瑞雪兆丰', banner: '' }, { demand: '', wantBanner: false, bannerLen: 4, category: '通用' }) // null
 */
export function validateReply(c: Couplet, req: LlmRequest): string | null {
  if (!c.up || !c.down) return '没有同时写出上联和下联'
  for (const [label, s] of [['上联', c.up], ['下联', c.down]] as const) {
    if (![...s].every((ch) => /\p{Script=Han}/u.test(ch) || PUNCT.includes(ch))) return `${label}里有汉字和标点之外的字符`
    const n = hanCount(s)
    if (n < LINE_MIN || n > LINE_MAX) return `${label}的字数不合适（${n} 字）`
  }
  if (hanCount(c.up) !== hanCount(c.down)) return `上联 ${hanCount(c.up)} 字、下联 ${hanCount(c.down)} 字，字数不相等`
  if (JSON.stringify(segmentLengths(c.up)) !== JSON.stringify(segmentLengths(c.down))) return '上下联的断句位置不一致'
  if (c.up === c.down) return '上联和下联一样'
  if (req.wantBanner) {
    if (!c.banner) return '没有写横批'
    if (![...c.banner].every((ch) => /\p{Script=Han}/u.test(ch))) return '横批里有汉字之外的字符'
    if ([...c.banner].length !== req.bannerLen) return `横批 ${[...c.banner].length} 字，要求 ${req.bannerLen} 字`
  }
  return null
}

/** 调模型的函数：给提示词与第几次尝试（从 1 起），返回模型原文 */
export type RunPrompt = (prompt: string, attempt: number) => Promise<string>

/**
 * 生成一副对联：调模型 → 解析 → 校验，不合格带着原因重试，最多 {@link MAX_ATTEMPTS} 次。
 * 模型调用本身抛错（如未就绪、被取消）直接向上抛，不重试。
 *
 * @param req 请求
 * @param run 调模型的函数
 * @returns 成功或失败（失败带原因与最后一次原文）
 * @example const r = await generateCouplet(req, (p) => aiInvoke('prompt', { text: p }, { provider: 'local-qwen' }).then((x) => x.text ?? ''))
 */
export async function generateCouplet(req: LlmRequest, run: RunPrompt): Promise<GenerateResult> {
  let issue: string | undefined
  let raw = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    raw = await run(buildPrompt(req, issue), attempt)
    const parsed = parseReply(raw)
    const couplet: Couplet = { ...parsed, banner: req.wantBanner ? parsed.banner : '' }
    issue = validateReply(couplet, req) ?? undefined
    if (!issue) return { ok: true, couplet, attempts: attempt }
  }
  return { ok: false, reason: issue ?? '', raw, attempts: MAX_ATTEMPTS }
}

/** 出上联的字数选项：不限 */
export const UPPER_LEN_ANY = 0
/** 出上联的字数候选（汉字数） */
export const UPPER_LENS: readonly number[] = Array.from({ length: 9 }, (_, i) => i + 4)

/** 出上联的请求 */
export interface UpperRequest {
  /** 用户的要求，可空 */
  demand: string
  /** 类型名，取 {@link CATEGORY_HINTS} 的 name */
  category: string
  /** 上联汉字数；{@link UPPER_LEN_ANY} 为不限 */
  len: number
}

/** 出上联的结果：成功给上联，失败给原因与最后一次原文 */
export type UpperResult = { ok: true; up: string; attempts: number } | { ok: false; reason: string; raw: string; attempts: number }

/**
 * 拼“只出上联”的提示词。
 *
 * @param req 请求
 * @param lastIssue 上一次不合格的原因；给了就追加纠正要求
 * @returns 提示词文本
 * @example buildUpperPrompt({ demand: '', category: '春节', len: 7 })
 */
export function buildUpperPrompt(req: UpperRequest, lastIssue?: string): string {
  const cat = CATEGORY_HINTS.find((c) => c.name === req.category) ?? CATEGORY_HINTS[0]
  const lines = [
    '请你只出一句对联的上联，留给别人来对下联，不要写下联。',
    `用户要求：${req.demand.trim() || FREE_STYLE}`,
    `类型：${cat.name}（${cat.hint}）`,
    `规则：${req.len ? `上联正好 ${req.len} 个汉字；` : ''}便于对仗（词性分明、结构清楚），末字仄声；不要照抄用户的话；只用汉字和逗号句号。`,
    '输出格式（只输出这一行，不要解释，不要加序号）：',
    '上联：……',
  ]
  if (lastIssue) lines.push(`上一次的问题：${lastIssue}。这次请严格按规则重写。`)
  return lines.join('\n')
}

/**
 * 校验模型出的上联。
 *
 * @param up 上联原文
 * @param len 要求的汉字数，{@link UPPER_LEN_ANY} 不限
 * @returns 不合格的原因；合格返回 null
 */
export function validateUpperReply(up: string, len: number): string | null {
  if (!up) return '没有写出上联'
  if (![...up].every((ch) => /\p{Script=Han}/u.test(ch) || PUNCT.includes(ch))) return '上联里有汉字和标点之外的字符'
  const n = hanCount(up)
  if (n < LINE_MIN || n > LINE_MAX) return `上联的字数不合适（${n} 字）`
  if (len && n !== len) return `上联 ${n} 字，要求 ${len} 字`
  return null
}

/**
 * 让模型出一句上联：调模型 → 解析 → 校验，不合格带原因重试，最多 {@link MAX_ATTEMPTS} 次。
 * 模型没按格式写“上联：”时，退而取第一行非空文字。模型调用抛错直接向上抛。
 *
 * @param req 请求
 * @param run 调模型的函数
 * @returns 成功或失败
 * @example const r = await generateUpper({ demand: '', category: '通用', len: 7 }, run)
 */
export async function generateUpper(req: UpperRequest, run: RunPrompt): Promise<UpperResult> {
  let issue: string | undefined
  let raw = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    raw = await run(buildUpperPrompt(req, issue), attempt)
    const up = parseReply(raw).up || cleanValue(raw.split(/\r?\n/).find((l) => l.trim()) ?? '')
    issue = validateUpperReply(up, req.len) ?? undefined
    if (!issue) return { ok: true, up, attempts: attempt }
  }
  return { ok: false, reason: issue ?? '', raw, attempts: MAX_ATTEMPTS }
}

/**
 * 校验“对下联”的上联输入（与原生 `native.ai.couplet` 的约束一致）。
 *
 * @param text 用户输入的上联
 * @param maxChars 原生报价的最大字数，默认 14
 * @returns 问题描述；合格返回 null
 * @example validateUpper('春风送暖入屠苏') // null
 */
export function validateUpper(text: string, maxChars = 14): string | null {
  const s = text.trim()
  if (!s) return '请先写上联'
  if ([...s].length > maxChars) return `上联最多 ${maxChars} 字`
  if (![...s].every((ch) => /\p{Script=Han}/u.test(ch) || PUNCT.includes(ch))) return '上联只能写汉字和常用标点（，。、；：！？）'
  if (hanCount(s) < 1) return '上联至少要有一个汉字'
  return null
}
