// HTTP 状态码查询逻辑：分类、搜索、按大类分组
import { STATUS_LIST, type StatusEntry } from './data'

/** 一组同大类的状态码 */
export interface StatusGroup {
  /** 大类编号 1~5 */
  cls: number
  /** 该大类下的条目 */
  items: StatusEntry[]
}

/** 状态码是三位数字 */
const CODE_LENGTH = 3

/**
 * 求状态码所属大类。
 *
 * @param code 状态码
 * @returns 1~5；不是三位有效状态码返回 0
 * @example
 * classOf(404) // 4
 */
export function classOf(code: number): number {
  if (!Number.isInteger(code) || code < 100 || code > 599) return 0
  return Math.floor(code / 100)
}

/**
 * 按码值精确查一条。
 *
 * @param code 状态码
 * @returns 条目；表里没有返回 undefined
 * @example
 * findStatus(404)?.name // "未找到"
 */
export function findStatus(code: number): StatusEntry | undefined {
  return STATUS_LIST.find((s) => s.code === code)
}

/**
 * 搜索状态码：纯数字按码前缀匹配（"40" 命中 40x），否则在名称、英文短语、含义、场景里找关键字。
 *
 * @param query 关键字，空串返回全部
 * @returns 命中的条目，按码值升序
 * @example
 * searchStatus('429')[0].name // "请求太多"
 * searchStatus('超时').length > 0 // true
 */
export function searchStatus(query: string): StatusEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return STATUS_LIST.slice()
  if (/^\d+$/.test(q) && q.length <= CODE_LENGTH) return STATUS_LIST.filter((s) => String(s.code).startsWith(q))
  return STATUS_LIST.filter(
    (s) => [s.name, s.phrase, s.meaning, s.scene].some((t) => t.toLowerCase().includes(q)),
  )
}

/**
 * 按大类分组，空组不返回。
 *
 * @param list 条目列表
 * @returns 按 1xx~5xx 排序的分组
 * @example
 * groupByClass(searchStatus('40')).map((g) => g.cls) // [4]
 */
export function groupByClass(list: StatusEntry[]): StatusGroup[] {
  const groups: StatusGroup[] = []
  for (let cls = 1; cls <= 5; cls++) {
    const items = list.filter((s) => classOf(s.code) === cls)
    if (items.length) groups.push({ cls, items })
  }
  return groups
}
