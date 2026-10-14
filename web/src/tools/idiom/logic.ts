// 成语查询的纯逻辑：拼音处理、搜索排序、接龙匹配。数据由 IdiomSource 提供。
import { BUILTIN_IDIOMS, type Idiom } from './data'

export type { Idiom } from './data'

/** 搜索结果最多条数 */
export const MAX_RESULTS = 50

/** 拼音声调组合记号的 Unicode 范围正则（NFD 分解后删除） */
const COMBINING_MARKS = /[̀-ͯ]/g

/** 判断是否含汉字 */
const HAN_RE = /[一-鿿]/

/** 空白字符正则 */
const SPACES_RE = /\s+/g

/** 排序分值：精确 > 前缀 > 包含 > 释义命中，越小越靠前 */
const SCORE = { exact: 0, prefix: 1, contains: 2, meaning: 3 } as const

/**
 * 成语数据源。内置精选词库实现了它；
 * 日后下载完整数据包时，实现同一接口即可替换，界面与逻辑不用改。
 */
export interface IdiomSource {
  /** 返回全部成语条目 */
  all(): Idiom[]
}

/** 内置精选词库数据源 */
export const builtinSource: IdiomSource = {
  all: () => BUILTIN_IDIOMS,
}

/** 搜索命中结果 */
export interface SearchHit {
  /** 命中的成语 */
  idiom: Idiom
  /** 排序分值，越小越相关 */
  score: number
}

/** 接龙候选 */
export interface ChainItem {
  /** 候选成语 */
  idiom: Idiom
  /** 首字读音与上一个成语末字读音是否不同（同字不同音） */
  diffSound: boolean
}

/**
 * 去掉拼音声调并统一写法：小写、ü 与 v 都写作 u、去空白。
 * @param s 带声调或无声调的拼音
 * @returns 无声调、无空格的小写拼音
 * @example stripTone('yī xīn yī yì') // 'yixinyiyi'
 */
export function stripTone(s: string): string {
  return s
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[üv]/g, 'u')
    .replace(SPACES_RE, '')
}

/**
 * 取拼音每个音节的首字母。
 * @param pinyin 空格分隔的拼音
 * @returns 首字母缩写（小写）
 * @example initials('yì qì fēng fā') // 'yqff'
 */
export function initials(pinyin: string): string {
  return pinyin
    .split(SPACES_RE)
    .filter(Boolean)
    .map((syl) => stripTone(syl).charAt(0))
    .join('')
}

/**
 * 按字符串匹配程度打分。
 * @param text 被匹配文本
 * @param q 查询串
 * @returns 精确/前缀/包含对应分值；不匹配返回 -1
 */
function matchScore(text: string, q: string): number {
  if (text === q) return SCORE.exact
  if (text.startsWith(q)) return SCORE.prefix
  if (text.includes(q)) return SCORE.contains
  return -1
}

/**
 * 在成语里搜索：支持汉字（包含/前缀）、拼音（带声调或不带）、首字母缩写、释义关键字。
 * 排序：精确 > 前缀 > 包含 > 释义命中，同分保持词库原顺序。
 * @param items 成语列表（通常来自 IdiomSource.all()）
 * @param query 用户输入，空串返回空数组
 * @param limit 最多返回条数，默认 50
 * @returns 命中结果，按相关度排序
 * @example searchIdioms(all, 'yxzx')[0].idiom.word // 例如 '一心一意' 等首字母为 yxzx 的成语
 */
export function searchIdioms(items: Idiom[], query: string, limit: number = MAX_RESULTS): SearchHit[] {
  const raw = query.trim()
  if (!raw) return []
  const hits: SearchHit[] = []
  if (HAN_RE.test(raw)) {
    const q = raw.replace(SPACES_RE, '')
    for (const idiom of items) {
      let score = matchScore(idiom.word, q)
      if (score < 0 && idiom.meaning.includes(q)) score = SCORE.meaning
      if (score >= 0) hits.push({ idiom, score })
    }
  } else {
    const plain = stripTone(raw)
    // 查询里带声调符号时，再用带调拼音精确比对
    const toned = raw.toLowerCase().replace(SPACES_RE, '')
    const hasTone = /[^a-z]/.test(toned)
    for (const idiom of items) {
      // 带调查询只和带调拼音比，避免 àn 误中 ān
      const scores = hasTone
        ? [matchScore(idiom.pinyin.replace(SPACES_RE, ''), toned)]
        : [matchScore(stripTone(idiom.pinyin), plain), matchScore(initials(idiom.pinyin), plain)]
      const ok = scores.filter((s) => s >= 0)
      if (ok.length) hits.push({ idiom, score: Math.min(...ok) })
    }
  }
  // Array.prototype.sort 在 Chrome 80 已稳定，同分保持原顺序
  hits.sort((a, b) => a.score - b.score)
  return hits.slice(0, limit)
}

/**
 * 取成语末字。
 * @param word 成语
 * @returns 最后一个字符（空串返回空串）
 * @example lastChar('一心一意') // '意'
 */
export function lastChar(word: string): string {
  const chars = Array.from(word)
  return chars.length ? chars[chars.length - 1] : ''
}

/**
 * 成语接龙：列出以给定成语末字开头的其它成语。
 * 同字不同音的也列出，用 diffSound 标注。
 * @param items 成语列表
 * @param idiom 当前成语
 * @returns 接龙候选（不含自身），同音的排在前面
 * @example chainNext(all, yiXinYiYi).map((c) => c.idiom.word) // 含 '意气风发'
 */
export function chainNext(items: Idiom[], idiom: Idiom): ChainItem[] {
  const end = lastChar(idiom.word)
  const endToned = (idiom.pinyin.split(SPACES_RE).pop() || '').toLowerCase()
  const list: ChainItem[] = []
  for (const cand of items) {
    if (cand.word === idiom.word || Array.from(cand.word)[0] !== end) continue
    const first = (cand.pinyin.split(SPACES_RE)[0] || '').toLowerCase()
    list.push({ idiom: cand, diffSound: first !== endToned })
  }
  // 同音在前（false < true），同类保持原顺序
  list.sort((a, b) => Number(a.diffSound) - Number(b.diffSound))
  return list
}

/**
 * 随机取一个成语。
 * @param items 成语列表
 * @param rand 随机数函数，返回 [0,1)，默认 Math.random（测试可注入）
 * @returns 随机成语；列表为空返回 undefined
 * @example randomIdiom(all, () => 0)?.word // 列表第一个成语
 */
export function randomIdiom(items: Idiom[], rand: () => number = Math.random): Idiom | undefined {
  if (!items.length) return undefined
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))]
}

/**
 * 按成语文字查找条目。
 * @param items 成语列表
 * @param word 成语
 * @returns 找到的条目或 undefined
 */
export function findIdiom(items: Idiom[], word: string): Idiom | undefined {
  return items.find((i) => i.word === word)
}
