// Linux 手册：搜索、筛选、统计

import type { Category, LinuxCmd } from './types'

/** 匹配得分：越小越靠前 */
const SCORE_EXACT = 0
const SCORE_ALIAS_EXACT = 1
const SCORE_PREFIX = 2
const SCORE_CONTAINS = 3
const SCORE_ALIAS = 4
const SCORE_BRIEF = 5
/** 未命中 */
const SCORE_NONE = Infinity

/**
 * 计算一条命令对关键词的匹配得分。
 *
 * @param cmd 命令
 * @param q 已转小写并去空白的关键词，非空
 * @returns 得分，越小越相关；未命中为 Infinity
 * @example scoreCommand(cmd, 'ls') // 命令名正是 ls 时为 0
 */
export function scoreCommand(cmd: LinuxCmd, q: string): number {
  const name = cmd.name.toLowerCase()
  if (name === q) return SCORE_EXACT
  const aliases = cmd.aliases.map((a) => a.toLowerCase())
  if (aliases.indexOf(q) >= 0) return SCORE_ALIAS_EXACT
  if (name.indexOf(q) === 0) return SCORE_PREFIX
  if (name.indexOf(q) > 0) return SCORE_CONTAINS
  if (aliases.some((a) => a.indexOf(q) >= 0)) return SCORE_ALIAS
  if (cmd.brief.toLowerCase().indexOf(q) >= 0) return SCORE_BRIEF
  return SCORE_NONE
}

/**
 * 搜索并按相关度排序，可同时按分类筛选。
 *
 * @param list 命令表
 * @param query 关键词，匹配命令名、别名、作用；空串则不过滤关键词
 * @param cat 分类，传空串或 undefined 表示全部
 * @returns 结果；有关键词时按得分升序、同分按命令名字典序，无关键词保持原顺序
 * @example searchCommands(COMMANDS, 'rm')[0].name // 'rm'
 */
export function searchCommands(list: readonly LinuxCmd[], query: string, cat?: Category | ''): LinuxCmd[] {
  const q = query.trim().toLowerCase()
  const pool = cat ? list.filter((x) => x.cat === cat) : list.slice()
  if (!q) return pool
  const scored: { cmd: LinuxCmd; s: number }[] = []
  for (const cmd of pool) {
    const s = scoreCommand(cmd, q)
    if (s !== SCORE_NONE) scored.push({ cmd, s })
  }
  scored.sort((a, b) => a.s - b.s || (a.cmd.name < b.cmd.name ? -1 : a.cmd.name > b.cmd.name ? 1 : 0))
  return scored.map((x) => x.cmd)
}

/**
 * 是否为危险命令。
 *
 * @param cmd 命令
 * @returns 有危险说明即为 true
 * @example isDanger(rmCmd) // true
 */
export function isDanger(cmd: LinuxCmd): boolean {
  return !!cmd.danger
}

/**
 * 统计各分类下的命令数。
 *
 * @param list 命令表
 * @returns 分类到数量的映射
 * @example countByCategory(COMMANDS)['网络'] // 14
 */
export function countByCategory(list: readonly LinuxCmd[]): Record<string, number> {
  const r: Record<string, number> = {}
  for (const x of list) r[x.cat] = (r[x.cat] || 0) + 1
  return r
}
