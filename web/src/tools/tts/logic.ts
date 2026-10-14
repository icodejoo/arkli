// 文字转语音：文本分段、语言匹配、顺序朗读进度（纯逻辑）

/** 页面允许输入的文本上限（超过原生单次 8000 字的部分由页面分段依次朗读） */
export const PAGE_MAX_TEXT = 60000
/** 原生单次朗读的文本上限 */
export const NATIVE_MAX_TEXT = 8000
/** 保存音频时的分段长度：引擎单次上限通常约 4000，留余量 */
export const SAVE_CHUNK = 3500
/** 语速、音调范围 */
export const FACTOR_RANGE = { min: 0.5, max: 2 } as const
/** 缺省语言 */
export const DEFAULT_LANG = 'zh-CN'
/** 找不到语音数据时的指引 */
export const INSTALL_GUIDE = '这台设备的语音引擎没有该语言的语音数据。请到系统设置 > 语言和输入法（或 辅助功能）> 文字转语音，安装对应语言的语音包后重试。'
/** 引擎不可用时的指引 */
export const NO_ENGINE_GUIDE = '没有可用的文字转语音引擎。请在系统设置 > 文字转语音 里选择或安装一个引擎。'

/** 句末标点，分段时优先在这里断开 */
const SENTENCE_ENDS = '。！？!?；;.\n'

/** 语言选项 */
export interface LangOption {
  /** 语言码 */
  code: string
  /** 中文名 */
  name: string
}

/** 可选语言 */
export const LANG_OPTIONS: LangOption[] = [
  { code: 'zh-CN', name: '普通话' },
  { code: 'zh-TW', name: '国语（台湾）' },
  { code: 'zh-HK', name: '粤语' },
  { code: 'en-US', name: '英语（美）' },
  { code: 'en-GB', name: '英语（英）' },
  { code: 'ja-JP', name: '日语' },
  { code: 'ko-KR', name: '韩语' },
  { code: 'fr-FR', name: '法语' },
  { code: 'de-DE', name: '德语' },
  { code: 'es-ES', name: '西班牙语' },
  { code: 'ru-RU', name: '俄语' },
]

/**
 * 在 (start, limit] 内找最合适的断点：句末标点之后 > 空白之后 > limit 本身（不劈开代理对）。
 *
 * @param text 全文
 * @param start 本段起点
 * @param limit 本段最远终点
 * @returns 断点下标（本段为 [start, 断点)）
 */
function cutPoint(text: string, start: number, limit: number): number {
  for (let i = limit; i > start; i--) {
    if (SENTENCE_ENDS.includes(text[i - 1])) return i
  }
  for (let i = limit; i > start; i--) {
    if (/\s/.test(text[i - 1])) return i
  }
  const code = text.charCodeAt(limit - 1)
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
}

/**
 * 把长文本切成不超过 max 字符的若干段，尽量在句末断开，其次在空白处，实在没有才硬切。
 *
 * @param text 文本
 * @param max 单段上限，必须大于 1
 * @returns 非空分段（纯空白的段被丢掉）
 * @example splitText('第一句。第二句。', 5) // ['第一句。', '第二句。']
 */
export function splitText(text: string, max: number): string[] {
  if (max < 2) throw new RangeError('max 至少为 2')
  if (text.length <= max) return text.trim() ? [text] : []
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    if (text.length - start <= max) {
      out.push(text.slice(start))
      break
    }
    const end = cutPoint(text, start, start + max)
    out.push(text.slice(start, end))
    start = end
  }
  return out.filter((s) => s.trim() !== '')
}

/**
 * 夹语速 / 音调到 0.5~2，非数字回到 1，保留两位小数。
 *
 * @param v 输入
 * @returns 合法值
 */
export function clampFactor(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.round(Math.min(FACTOR_RANGE.max, Math.max(FACTOR_RANGE.min, n)) * 100) / 100
}

/** 取语言标签的主语言（小写）；cmn 等同 zh */
function primary(tag: string): string {
  const p = tag.replace('_', '-').split('-')[0].toLowerCase()
  return p === 'cmn' ? 'zh' : p
}

/** 取语言标签的地区（大写，两位字母），没有为空串 */
function region(tag: string): string {
  const parts = tag.replace('_', '-').split('-').slice(1)
  const r = parts.find((x) => /^[A-Za-z]{2}$/.test(x))
  return r ? r.toUpperCase() : ''
}

/**
 * 引擎报告的语言里有没有想用的。主语言一致，且（想用的没写地区 / 引擎那条没写地区 / 地区一致）。
 *
 * @param available 引擎可用语言标签
 * @param want 想用的语言码
 * @returns 匹配为 true
 * @example langAvailable(['zh-CN', 'en-US'], 'zh-CN') // true
 */
export function langAvailable(available: string[], want: string): boolean {
  const wp = primary(want)
  const wr = region(want)
  return available.some((a) => primary(a) === wp && (wr === '' || region(a) === '' || region(a) === wr))
}

/**
 * 按引擎能力筛选语言选项；引擎没报告语言（空列表）时全部保留，让用户自己试。
 *
 * @param available 引擎可用语言标签
 * @returns 可选语言
 */
export function usableLangs(available: string[]): LangOption[] {
  if (available.length === 0) return LANG_OPTIONS
  return LANG_OPTIONS.filter((o) => langAvailable(available, o.code))
}

/**
 * 把原生错误转成给人看的提示。
 *
 * @param e 捕获到的错误
 * @returns 中文提示
 */
export function describeError(e: unknown): string {
  const err = e as { code?: string; message?: string }
  if (err?.code === 'NOT_READY') return err.message?.includes('没有') ? INSTALL_GUIDE : NO_ENGINE_GUIDE
  return err?.message || '朗读失败'
}

/** 顺序朗读的进度 */
export interface Reader {
  /** 全部分段 */
  chunks: string[]
  /** 当前段下标 */
  index: number
}

/**
 * 创建顺序朗读进度：文本按原生单次上限切段，一段读完再读下一段。
 *
 * @param text 全文
 * @param max 单段上限，缺省 8000
 * @returns 进度，没有可读内容时 chunks 为空
 */
export function createReader(text: string, max = NATIVE_MAX_TEXT): Reader {
  return { chunks: splitText(text, max), index: 0 }
}

/**
 * 当前该读的段；读完了返回 null。
 *
 * @param r 进度
 * @returns 文本或 null
 */
export function currentChunk(r: Reader): string | null {
  return r.index < r.chunks.length ? r.chunks[r.index] : null
}

/**
 * 当前段读完，移到下一段。
 *
 * @param r 进度
 * @returns 新进度（不改原对象）
 */
export function nextChunk(r: Reader): Reader {
  return { chunks: r.chunks, index: r.index + 1 }
}

/**
 * 进度文字：只有一段时为空串，多段显示 `2 / 5`。
 *
 * @param r 进度
 * @returns 文字
 */
export function progressLabel(r: Reader): string {
  if (r.chunks.length <= 1) return ''
  return `${Math.min(r.index + 1, r.chunks.length)} / ${r.chunks.length}`
}
