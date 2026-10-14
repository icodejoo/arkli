// 垃圾分类检索：按名称/别名做精确 > 前缀 > 包含 > 反向包含的排序，纯本地。

import { CATS, WASTE_ITEMS, type CatInfo, type WasteCat, type WasteItem } from './data'

/** 一条检索结果 */
export interface SearchHit {
  /** 命中的词条 */
  item: WasteItem
  /** 得分，越高越靠前 */
  score: number
  /** 若通过别名命中，则为该别名；名称命中为空串 */
  matchedAlias: string
}

/** 名称精确匹配得分 */
export const SCORE_NAME_EXACT = 100
/** 别名精确匹配得分 */
export const SCORE_ALIAS_EXACT = 90
/** 名称前缀匹配得分 */
export const SCORE_NAME_PREFIX = 80
/** 别名前缀匹配得分 */
export const SCORE_ALIAS_PREFIX = 70
/** 名称包含匹配得分 */
export const SCORE_NAME_INCLUDES = 60
/** 别名包含匹配得分 */
export const SCORE_ALIAS_INCLUDES = 50
/** 反向包含（输入里含有词条名，如"一大堆旧报纸"）得分 */
export const SCORE_QUERY_CONTAINS = 40
/** 反向包含要求词条名至少这么长，避免单字乱配 */
export const MIN_REVERSE_LEN = 2
/** 默认最多返回条数 */
export const DEFAULT_LIMIT = 30

/**
 * 规整查询词：去首尾空白、内部空白，英文转小写。
 *
 * @param q 用户输入
 * @returns 规整后的文本
 * @example normalizeQuery('  U 盘 ') // 'u盘'
 */
export function normalizeQuery(q: string): string {
  return q.replace(/\s+/g, '').toLowerCase()
}

/**
 * 给一段文本打分（名称与别名分别用不同分档）。
 *
 * @param text 词条的名称或别名（已小写）
 * @param q 规整后的查询词
 * @param exact 精确得分
 * @param prefix 前缀得分
 * @param includes 包含得分
 * @returns 得分，没命中为 0
 */
function scoreText(text: string, q: string, exact: number, prefix: number, includes: number): number {
  if (text === q) return exact
  if (text.startsWith(q)) return prefix
  if (text.includes(q)) return includes
  return 0
}

/**
 * 在词典里检索。排序：得分高优先；同分名称短的优先；再同分保持词典原顺序。
 * 空查询返回空数组。
 *
 * @param query 用户输入
 * @param items 词典，默认用内置词典（测试可注入）
 * @param limit 最多返回条数
 * @returns 命中列表
 * @example search('报纸')[0].item.cat // 'recyclable'
 */
export function search(query: string, items: WasteItem[] = WASTE_ITEMS, limit: number = DEFAULT_LIMIT): SearchHit[] {
  const q = normalizeQuery(query)
  if (!q) return []
  const hits: Array<SearchHit & { order: number }> = []
  items.forEach((item, order) => {
    const name = item.name.toLowerCase()
    let best = scoreText(name, q, SCORE_NAME_EXACT, SCORE_NAME_PREFIX, SCORE_NAME_INCLUDES)
    let matchedAlias = ''
    for (const a of item.alias) {
      const s = scoreText(a.toLowerCase(), q, SCORE_ALIAS_EXACT, SCORE_ALIAS_PREFIX, SCORE_ALIAS_INCLUDES)
      if (s > best) {
        best = s
        matchedAlias = a
      }
    }
    if (best === 0 && name.length >= MIN_REVERSE_LEN && q.includes(name)) best = SCORE_QUERY_CONTAINS
    if (best > 0) hits.push({ item, score: best, matchedAlias, order })
  })
  hits.sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length || a.order - b.order)
  return hits.slice(0, limit).map(({ item, score, matchedAlias }) => ({ item, score, matchedAlias }))
}

/**
 * 取分类的展示信息。
 *
 * @param cat 分类标识
 * @returns 展示信息；未知分类返回 undefined
 * @example getCat('wet')?.name // '湿垃圾'
 */
export function getCat(cat: WasteCat): CatInfo | undefined {
  return CATS.find((c) => c.id === cat)
}

/**
 * 统计各分类的词条数。
 *
 * @param items 词典
 * @returns 每类条数
 */
export function countByCat(items: WasteItem[] = WASTE_ITEMS): Record<WasteCat, number> {
  const r: Record<WasteCat, number> = { recyclable: 0, hazardous: 0, wet: 0, dry: 0 }
  for (const i of items) r[i.cat]++
  return r
}

/**
 * 找出词典里重复的名称或别名（含名称与别名互相撞）。
 *
 * @param items 词典
 * @returns 重复的字符串列表（去重）
 */
export function findDuplicates(items: WasteItem[] = WASTE_ITEMS): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const i of items) {
    for (const k of new Set([i.name, ...i.alias])) {
      const key = k.toLowerCase()
      if (seen.has(key)) dup.add(k)
      seen.add(key)
    }
  }
  return [...dup]
}
