// 极短输入判定与路由：NLLB 对极短输入译文不准，先查短语表，再看能否改用本地大模型
import { allowsAuto, AUTO_CODE, isSupported, type LangConstraints, type LangPair } from '@/shared/languages'
import { lookupPhrase } from './phrases'

/** 中文极短阈值：去标点后字符数 ≤ 此值 */
export const SHORT_ZH_MAX = 4
/** 其他语言极短阈值：词数 ≤ 此值 */
export const SHORT_WORDS_MAX = 2
/** NLLB 提供者 id */
export const PROVIDER_NLLB = 'local-nllb'
/** Qwen 提供者 id */
export const PROVIDER_QWEN = 'local-qwen'
/** 改用大模型后的结果下方提示 */
export const MSG_SHORT_TO_QWEN = '短文本已改用本地大模型翻译，更准'

/** 中文语言码 */
const ZH = 'zh-CN'
/** CJK 汉字 */
const CJK = /[一-鿿]/
/** 首尾要去掉的空白与标点 */
const EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu
/** 带上下文的内部分隔标点：出现即不算极短 */
const INNER_SEP = /[,，、;；:：]/

/**
 * 是不是极短输入：去首尾空白与标点后，中文按字符数 ≤ {@link SHORT_ZH_MAX}，其他语言按词数 ≤ {@link SHORT_WORDS_MAX}；
 * 内部含逗号等分隔标点的当作带上下文，不算极短。源语言 auto 时含汉字就按中文算。
 *
 * @param text 原文
 * @param srcLang 源语言码（可为 auto）
 * @returns 极短为 true；去标点后为空为 false
 * @example isUltraShort('你好', 'zh-CN') // true
 * @example isUltraShort('你好，世界！', 'zh-CN') // false
 */
export function isUltraShort(text: string, srcLang: string): boolean {
  const core = text.replace(EDGE, '')
  if (!core || INNER_SEP.test(core)) return false
  const zh = srcLang === ZH || (srcLang === AUTO_CODE && CJK.test(core))
  if (zh) return Array.from(core.replace(/\s+/g, '')).length <= SHORT_ZH_MAX
  return core.split(/\s+/).length <= SHORT_WORDS_MAX
}

/** 路由决策结果 */
export type ShortRoute = { kind: 'phrase'; text: string } | { kind: 'qwen' } | { kind: 'selected' }

/** 路由决策的输入 */
export interface ShortRouteInput {
  /** 所选提供者 id */
  provider: string | undefined
  /** 原文 */
  text: string
  /** 源语言码 */
  src: string
  /** 目标语言码 */
  tgt: string
  /** Qwen 是否已安装 */
  qwenReady: boolean
  /** Qwen 是否支持当前语言对 */
  qwenSupportsPair: boolean
}

/**
 * 决定本次翻译怎么走：仅所选是 NLLB 且输入极短时生效；命中短语表直接出译文，否则 Qwen 就绪且支持语言对时改用 Qwen，其余照所选。
 *
 * @param i 路由输入
 * @returns `phrase` 直接出译文 / `qwen` 改用大模型 / `selected` 按所选
 * @example routeShort({ provider: 'local-nllb', text: '你好', src: 'zh-CN', tgt: 'en', qwenReady: false, qwenSupportsPair: false }) // { kind: 'phrase', text: 'Hello' }
 */
export function routeShort(i: ShortRouteInput): ShortRoute {
  if (i.provider !== PROVIDER_NLLB || !isUltraShort(i.text, i.src)) return { kind: 'selected' }
  const phrase = lookupPhrase(i.text, i.src, i.tgt)
  if (phrase !== null) return { kind: 'phrase', text: phrase }
  if (i.qwenReady && i.qwenSupportsPair) return { kind: 'qwen' }
  return { kind: 'selected' }
}

/**
 * 提供者的翻译约束是否覆盖语言对：目标与源都在支持清单内；源为 auto 时要求支持自动检测。
 *
 * @param constraints 提供者翻译报价的约束，缺省视为不支持
 * @param pair 当前语言对
 * @returns 支持为 true
 * @example isPairSupported({ languages: ['en', 'zh-CN'] }, { src: 'en', tgt: 'zh-CN' }) // true
 */
export function isPairSupported(constraints: LangConstraints | undefined, pair: LangPair): boolean {
  if (!constraints) return false
  const srcOk = pair.src === AUTO_CODE ? allowsAuto(constraints) : isSupported(constraints, pair.src)
  return srcOk && isSupported(constraints, pair.tgt)
}
