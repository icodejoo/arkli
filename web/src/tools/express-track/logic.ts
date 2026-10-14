// 快递单号识别：规整输入，按规则表匹配，列出候选公司（可信度高的在前）。

import { CARRIERS, type Carrier } from './data'

/** 单号最短长度 */
export const MIN_NO_LEN = 8
/** 单号最长长度 */
export const MAX_NO_LEN = 30
/** 最近查询最多保留条数 */
export const MAX_HISTORY = 10
/** 可信度中文名 */
export const CONFIDENCE_LABEL: Record<1 | 2 | 3, string> = { 3: '较可信', 2: '一般', 1: '仅供参考' }

/** 一个候选结果 */
export interface Candidate {
  /** 快递公司 */
  carrier: Carrier
  /** 命中的最高可信度 */
  confidence: 1 | 2 | 3
  /** 命中规则的说明 */
  note: string
}

/** 识别结果 */
export interface IdentifyResult {
  /** 规整后的单号 */
  no: string
  /** 候选公司，按可信度降序 */
  candidates: Candidate[]
  /** 输入不合法时的原因；合法时为空串 */
  error: string
}

/**
 * 把全角字母数字转成半角。
 *
 * @param s 输入
 * @returns 半角文本
 */
function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

/**
 * 规整单号：全角转半角、转大写，去掉空白、连字符和下划线。
 *
 * @param input 用户输入或粘贴的文本
 * @returns 规整后的单号
 * @example normalizeNo(' sf-1234 5678 ') // 'SF12345678'
 */
export function normalizeNo(input: string): string {
  return toHalfWidth(input).toUpperCase().replace(/[\s\-_]/g, '')
}

/**
 * 识别单号可能属于哪些快递公司。同一公司命中多条规则时取可信度最高的一条；
 * 候选先按可信度降序，同可信度保持规则表里的顺序。
 *
 * @param input 用户输入
 * @param carriers 规则表，默认用内置的（测试可注入）
 * @returns 规整后的单号、候选与错误原因
 * @example identify('SF1234567890123').candidates[0].carrier.name // '顺丰速运'
 */
export function identify(input: string, carriers: Carrier[] = CARRIERS): IdentifyResult {
  const no = normalizeNo(input)
  if (!no) return { no, candidates: [], error: '请输入快递单号' }
  if (!/^[A-Z0-9]+$/.test(no)) return { no, candidates: [], error: '单号只能包含字母和数字' }
  if (no.length < MIN_NO_LEN || no.length > MAX_NO_LEN) {
    return { no, candidates: [], error: `单号长度一般在 ${MIN_NO_LEN}~${MAX_NO_LEN} 位之间` }
  }
  const found: Candidate[] = []
  for (const carrier of carriers) {
    let best: Candidate | undefined
    for (const rule of carrier.rules) {
      if (rule.pattern.test(no) && (!best || rule.confidence > best.confidence)) {
        best = { carrier, confidence: rule.confidence, note: rule.note }
      }
    }
    if (best) found.push(best)
  }
  // Array.prototype.sort 在 Chrome 70+ 是稳定排序，同可信度保持原顺序
  found.sort((a, b) => b.confidence - a.confidence)
  return { no, candidates: found, error: '' }
}

/**
 * 把单号放到最近查询列表最前面，去重并限制条数。
 *
 * @param list 现有列表
 * @param no 单号
 * @param max 最多保留条数
 * @returns 新列表（不改原数组）
 * @example pushHistory(['A'], 'B') // ['B', 'A']
 */
export function pushHistory(list: string[], no: string, max: number = MAX_HISTORY): string[] {
  if (!no) return list
  return [no, ...list.filter((x) => x !== no)].slice(0, max)
}
