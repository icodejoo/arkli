import type { ToolMeta } from '@/tools/registry'

/**
 * 按关键词过滤工具，匹配名称或简介（忽略大小写与首尾空格）。
 *
 * @param list 工具列表
 * @param keyword 搜索词；空串返回全部
 * @returns 过滤后的数组
 * @example
 * filterTools(tools, 'base') // 命中 Base64、进制转换等
 */
export function filterTools(list: ToolMeta[], keyword: string): ToolMeta[] {
  const k = keyword.trim().toLowerCase()
  if (!k) return list
  return list.filter((t) => t.name.toLowerCase().includes(k) || t.description.toLowerCase().includes(k))
}
