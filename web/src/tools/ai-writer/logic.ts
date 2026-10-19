/**
 * AI 写作助手的纯逻辑：各模式的 system 提示词与参数构造、输入截断、候选解析。
 * 走原生 `prompt` 预设（Qwen 0.8B）：单次最多生成 256 token，system ≤ 2000 字符，input ≤ 50000 字符。
 */

/** 写作模式 */
export type WriterMode = 'name' | 'title' | 'polish' | 'expand' | 'shrink'
/** 起名类别 */
export type NameKind = 'person' | 'shop' | 'pet'

/** 模式列表（界面 tabs 顺序） */
export const WRITER_MODES: ReadonlyArray<{ key: WriterMode; label: string }> = [
  { key: 'name', label: '起名' },
  { key: 'title', label: '起标题' },
  { key: 'polish', label: '润色' },
  { key: 'expand', label: '扩写' },
  { key: 'shrink', label: '缩写' },
]
/** 起名类别列表 */
export const NAME_KINDS: ReadonlyArray<{ key: NameKind; label: string }> = [
  { key: 'person', label: '人名' },
  { key: 'shop', label: '店名' },
  { key: 'pet', label: '宠物名' },
]

/** 原生 system 上限（字符） */
export const SYSTEM_MAX = 2000
/** 长文类模式（标题、润色、扩写、缩写）输入上限：留足生成空间，小模型输入太长也容易跑偏 */
export const TEXT_INPUT_MAX = 1200
/** 起名的用途/要求输入上限 */
export const NAME_INPUT_MAX = 100
/** 风格输入上限 */
export const STYLE_INPUT_MAX = 30
/** 模型单次最多生成的 token 数（提示用，实际由原生限制） */
export const MAX_NEW_TOKENS = 256
/** 采样温度：起名/标题要发散，润色/缩写要稳 */
export const TEMPERATURE: Record<WriterMode, number> = { name: 0.9, title: 0.8, polish: 0.3, expand: 0.7, shrink: 0.2 }
/** 原生预设 */
export const WRITER_PRESET = 'prompt' as const
/** 每个模式的小模型提示 */
export const MODE_NOTE = '小模型输出仅供参考，请自己把关'
/** 输入被截断时的提示 */
export const MSG_TRUNCATED = (max: number): string => `输入太长，已按前 ${max} 字处理`

/** 起名类别的提示词描述 */
const KIND_PROMPT: Record<NameKind, string> = { person: '人名', shop: '店名', pet: '宠物名' }
/** 起名候选个数 */
export const NAME_COUNT = 6
/** 标题候选个数 */
export const TITLE_COUNT = 5

/** 构造请求的入参 */
export interface WriterParams {
  /** 模式 */
  mode: WriterMode
  /** 主输入：起名为用途/要求，其余为正文 */
  input: string
  /** 起名类别，仅起名用 */
  nameKind?: NameKind
  /** 风格，仅起名用，可空 */
  style?: string
}

/** 构造出的请求 */
export interface WriterRequest {
  /** system 提示词 */
  system: string
  /** 用户输入（已截断） */
  text: string
  /** 采样温度 */
  temperature: number
  /** 输入是否被截断 */
  truncated: boolean
  /** 本模式的输入上限 */
  inputMax: number
}

/** 截断结果 */
export interface Clamped {
  /** 截断后的文本 */
  text: string
  /** 是否被截断 */
  truncated: boolean
}

/**
 * 去首尾空白后按最大长度截断。
 *
 * @param s 原文
 * @param max 最大字符数
 * @returns 截断后文本与是否被截断
 * @example clampInput('abcdef', 3) // { text: 'abc', truncated: true }
 */
export function clampInput(s: string, max: number): Clamped {
  const t = s.trim()
  return t.length > max ? { text: t.slice(0, max), truncated: true } : { text: t, truncated: false }
}

/**
 * 某模式的输入上限。
 *
 * @param mode 模式
 * @returns 字符数
 * @example inputLimit('name') // 100
 */
export function inputLimit(mode: WriterMode): number {
  return mode === 'name' ? NAME_INPUT_MAX : TEXT_INPUT_MAX
}

/**
 * 构造某模式的 system 提示词（固定长度，远小于 2000 字符）。
 *
 * @param mode 模式
 * @param nameKind 起名类别
 * @param style 风格（仅起名）
 * @returns system 文本
 * @example buildSystem('title') // '你是文案助手……'
 */
export function buildSystem(mode: WriterMode, nameKind: NameKind = 'person', style = ''): string {
  const s = style.trim().slice(0, STYLE_INPUT_MAX)
  switch (mode) {
    case 'name': {
      const k = KIND_PROMPT[nameKind]
      const styleLine = s ? `风格：${s}。` : ''
      return `你是起名助手。根据用户说明起${k}，${styleLine}给出 ${NAME_COUNT} 个不同的${k}，每行一个，格式为“序号. 名字”，不要解释。`
    }
    case 'title':
      return `你是标题助手。为用户给出的内容拟 ${TITLE_COUNT} 个不同的标题，每个不超过 20 字，每行一个，格式为“序号. 标题”，不要解释。`
    case 'polish':
      return '你是文字润色助手。在保持原意、不增删事实的前提下，把用户的文字改得更通顺自然，只输出润色后的文字，不要解释。'
    case 'expand':
      return '你是写作助手。把用户的文字扩写得更充实，补充细节但不编造具体数据，语言流畅，只输出扩写后的文字，不要解释。'
    case 'shrink':
      return '你是写作助手。把用户的文字缩写成更精炼的版本，保留关键信息，只输出缩写后的文字，不要解释。'
  }
}

/**
 * 构造一次生成请求：system、截断后的输入、温度。
 *
 * @param p 入参
 * @returns 请求；输入为空时 text 为空串，调用方应先拦截
 * @example buildRequest({ mode: 'polish', input: '今天天气好我们去玩' }) // { system, text, temperature: 0.3, … }
 */
export function buildRequest(p: WriterParams): WriterRequest {
  const inputMax = inputLimit(p.mode)
  const c = clampInput(p.input, inputMax)
  return {
    system: buildSystem(p.mode, p.nameKind, p.style),
    text: c.text,
    temperature: TEMPERATURE[p.mode],
    truncated: c.truncated,
    inputMax,
  }
}

/**
 * 校验输入是否可提交。
 *
 * @param p 入参
 * @returns 不可提交时的提示，可提交为 null
 * @example validateInput({ mode: 'name', input: '' }) // '先写点内容'
 */
export function validateInput(p: WriterParams): string | null {
  return p.input.trim() ? null : p.mode === 'name' ? '先说说起名的用途或要求' : '先写点内容'
}

/** 候选行前缀：序号、项目符号 */
const LEAD_RE = /^\s*(?:\d+\s*[.、)）:：]|[-*•·])\s*/
/** 候选两侧的引号、书名号 */
const WRAP_RE = /^[“"'《「『]+|[”"'》」』]+$/g

/**
 * 把起名/起标题的输出解析成候选列表：去序号、符号、引号，去重，空行丢弃。
 *
 * @param output 模型输出
 * @param max 最多取几个
 * @returns 候选数组
 * @example parseCandidates('1. 云间\n2. “山海”') // ['云间', '山海']
 */
export function parseCandidates(output: string, max = NAME_COUNT): string[] {
  const seen = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const t = line.replace(LEAD_RE, '').replace(WRAP_RE, '').trim()
    if (t) seen.add(t)
    if (seen.size >= max) break
  }
  return [...seen]
}

/**
 * 某模式的结果是否按候选列表展示。
 *
 * @param mode 模式
 * @returns 起名与起标题为 true
 */
export function isListMode(mode: WriterMode): boolean {
  return mode === 'name' || mode === 'title'
}
