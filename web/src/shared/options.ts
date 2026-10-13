// 选项列表解析：抽签与做个决定共用

/** 选项个数上限，防止误粘贴超大文本卡住页面 */
export const MAX_OPTIONS = 200

/** 选项分隔符：换行与中英文逗号、顿号、分号 */
const SEPARATORS = /[\n\r,，、;；]+/

/** 解析结果 */
export interface ParsedOptions {
  /** 去空白、去重后的选项 */
  items: string[]
  /** 被忽略的重复项个数 */
  duplicates: number
  /** 是否因超过上限被截断 */
  truncated: boolean
}

/**
 * 把多行文本解析成选项列表。
 *
 * @param text 用户输入
 * @returns 解析结果；空输入得到空列表
 * @example
 * parseOptions('火锅, 烧烤\n火锅').items // ['火锅', '烧烤']
 */
export function parseOptions(text: string): ParsedOptions {
  const seen = new Set<string>()
  const items: string[] = []
  let duplicates = 0
  let truncated = false
  for (const raw of text.split(SEPARATORS)) {
    const s = raw.trim()
    if (!s) continue
    if (seen.has(s)) {
      duplicates++
      continue
    }
    if (items.length >= MAX_OPTIONS) {
      truncated = true
      break
    }
    seen.add(s)
    items.push(s)
  }
  return { items, duplicates, truncated }
}
