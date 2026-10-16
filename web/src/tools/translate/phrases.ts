// 超短输入的确定译文表：NLLB 对 1~4 字的短语译文不准，这里只收人工确认过正确的条目，命中就不调原生
import { AUTO_CODE } from '@/shared/languages'

/** 中文语言码 */
const ZH = 'zh-CN'
/** 英文语言码 */
const EN = 'en'
/** 匹配时忽略的末尾标点与空白 */
const TAIL_PUNCT = /[。！!？?.\s]+$/

/** 中译英短语表（键为规整后的原文） */
const ZH_TO_EN: Readonly<Record<string, string>> = {
  你好: 'Hello',
  您好: 'Hello',
  你好世界: 'Hello, world',
  大家好: 'Hello, everyone',
  谢谢: 'Thank you',
  谢谢你: 'Thank you',
  不客气: "You're welcome",
  再见: 'Goodbye',
  早上好: 'Good morning',
  对不起: 'Sorry',
  加油: 'Come on',
  救命: 'Help',
}

/** 英译中短语表（键为规整后的小写原文） */
const EN_TO_ZH: Readonly<Record<string, string>> = {
  hello: '你好',
  hi: '你好',
  goodbye: '再见',
  'thank you': '谢谢',
  thanks: '谢谢',
  'how are you': '你好吗',
  'good morning': '早上好',
  sorry: '对不起',
  help: '救命',
}

/**
 * 规整原文：去首尾空白、去末尾 `。！!？?.`、转小写。
 *
 * @param text 原文
 * @returns 规整后的查表键
 * @example normalizePhrase(' Hello! ') // 'hello'
 */
export function normalizePhrase(text: string): string {
  return text.trim().replace(TAIL_PUNCT, '').toLowerCase()
}

/**
 * 查短语表：精确匹配，忽略首尾空白、大小写与末尾句号类标点。源语言为 auto 时只按目标语言选表。
 *
 * @param text 原文
 * @param src 源语言码（可为 auto）
 * @param tgt 目标语言码
 * @returns 译文；不在表里或语言对不是中英互译为 null
 * @example lookupPhrase('你好世界！', 'zh-CN', 'en') // 'Hello, world'
 * @example lookupPhrase('Thanks', 'auto', 'zh-CN') // '谢谢'
 */
export function lookupPhrase(text: string, src: string, tgt: string): string | null {
  const key = normalizePhrase(text)
  if (!key) return null
  const srcOk = (code: string): boolean => src === code || src === AUTO_CODE
  if (tgt === EN && srcOk(ZH)) return ZH_TO_EN[key] ?? null
  if (tgt === ZH && srcOk(EN)) return EN_TO_ZH[key] ?? null
  return null
}
