// 翻译页的纯逻辑：语言选择规则、存取、错误归类（不依赖 Vue，便于单测）
import { isLang, isSourceLang, type LangPair } from '@/shared/languages'
import type { ToolStorage } from '@/shared/toolStorage'
import { DEFAULT_SRC, DEFAULT_TGT, LANGS_KEY, LEGACY_LANGS_KEY } from './data'

export type { LangPair }

/** 页面提示文案：模型未就绪 */
export const MSG_NOT_READY = '模型还没准备好，请先下载'
/** 结果下方的红色提示：有句子无法识别语言，原样放进了输出 */
export const MSG_UNRECOGNIZED = '部分字符无法识别'
/** 页面提示文案：参数不合法 */
export const MSG_BAD_PARAMS = '文字太长或语言不支持'
/** 页面提示文案：其它失败 */
export const MSG_FAILED = '翻译没成功，稍后再试'
/** 页面提示文案：找不到所选模型对应的翻译提供者（原生太旧或不在 App 里） */
export const MSG_NO_PROVIDER = '当前模型暂不能翻译'

/** 默认语言组合 */
export function defaultPair(): LangPair {
  return { src: DEFAULT_SRC, tgt: DEFAULT_TGT }
}

/** 交换源与目标 */
export function swapPair(pair: LangPair): LangPair {
  return { src: pair.tgt, tgt: pair.src }
}

/**
 * 校验缓存里的语言组合（源可为 auto，是否被当前模型支持由页面再纠正）；格式不对、语言不支持或两侧相同都回落默认值。
 *
 * @param v 缓存里读出的值
 * @returns 合法的语言组合
 */
export function sanitizePair(v: unknown): LangPair {
  const p = v as Partial<LangPair> | null
  if (p && isSourceLang(p.src) && isLang(p.tgt) && p.src !== p.tgt) return { src: p.src, tgt: p.tgt }
  return defaultPair()
}

/**
 * 解析旧版存储里的原始字符串。
 *
 * @param raw localStorage 里的原始字符串
 * @returns 合法的语言组合
 */
export function parsePair(raw: string | null): LangPair {
  try {
    return sanitizePair(JSON.parse(raw ?? 'null'))
  } catch {
    return defaultPair()
  }
}

/**
 * 从持久缓存读语言组合（首次会迁移旧键）；不可用时给默认值。
 *
 * @param store 翻译工具的持久缓存
 * @returns 语言组合
 */
export function readPair(store: ToolStorage): LangPair {
  store.adoptLegacy(LEGACY_LANGS_KEY, LANGS_KEY)
  return sanitizePair(store.get<unknown>(LANGS_KEY, null))
}

/**
 * 把语言组合写进持久缓存；失败忽略。
 *
 * @param store 翻译工具的持久缓存
 * @param pair 语言组合
 */
export function writePair(store: ToolStorage, pair: LangPair): void {
  store.set(LANGS_KEY, pair)
}

/**
 * 把翻译失败归类成给用户看的话；参数不合法时优先显示原生给的中文原因（如超过字数上限）。
 *
 * @param e 捕获到的错误（带原生 `code`）
 * @returns 人话提示
 * @example translateErrorMessage({ code: 'NOT_READY' }) // '模型还没准备好，请先下载'
 */
export function translateErrorMessage(e: unknown): string {
  const code = (e as { code?: string } | null)?.code
  if (code === 'NOT_READY') return MSG_NOT_READY
  if (code === 'BAD_PARAMS') return readableMessage(e) ?? MSG_BAD_PARAMS
  return MSG_FAILED
}

/** 含中文字符（原生给的人话提示都是中文，技术性英文消息不展示） */
const HAS_CJK = /[一-鿿]/

/** 取错误里原生给的中文提示（如“该模型最多翻译 300 字，请改用本地翻译模型”）；没有或不是中文为 undefined */
function readableMessage(e: unknown): string | undefined {
  const msg = (e as { message?: string } | null)?.message
  return msg && HAS_CJK.test(msg) ? msg : undefined
}

/**
 * 这一轮翻译是不是仍是最新一轮：异步等待之后写结果前必须检查，免得被取消或被新请求取代的旧结果覆盖新状态。
 *
 * @param mine 本轮开始时领到的序号
 * @param latest 当前最新序号
 * @returns 仍是最新为 true
 * @example if (!isLatestRun(my, seq)) return
 */
export function isLatestRun(mine: number, latest: number): boolean {
  return mine === latest
}

/**
 * 结果下方的红色提示文案。
 *
 * @param unrecognized 原生返回的 unrecognized
 * @returns 为真时返回提示，否则空串（不显示）
 * @example unrecognizedTip(true) // '部分字符无法识别'
 */
export function unrecognizedTip(unrecognized: boolean | undefined): string {
  return unrecognized ? MSG_UNRECOGNIZED : ''
}

/**
 * 交换输入框与译文框的内容（点交换按钮时用）：有译文才交换，译文超长则截断；没有译文时输入保持不动。
 *
 * @param input 当前输入
 * @param result 当前译文，空表示还没翻译
 * @param max 输入长度上限
 * @returns 交换后的输入与译文
 * @example
 * swapTexts('Hello', '你好', 2000) // { input: '你好', result: 'Hello' }
 */
export function swapTexts(input: string, result: string, max: number): { input: string; result: string } {
  if (!result) return { input, result }
  return { input: result.slice(0, max), result: input }
}
