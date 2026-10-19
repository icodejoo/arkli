// 随机点名：名单解析与抽签（纯函数，随机函数可注入）

/** 随机函数：返回 [0,1) */
export type Rand = () => number

/** 一次最多抽几人的上限 */
export const MAX_PICK = 20
/** 名单存储键 */
export const NAMES_KEY = 'arkli:roll-call:names'

/** 一次抽签的结果 */
export interface DrawResult {
  /** 本次抽中的人 */
  picked: string[]
  /** 抽完后的已抽集合（仅不重复模式有意义，重复模式原样返回） */
  used: string[]
  /** 还没被抽过的人数（重复模式等于名单总数） */
  left: number
  /** 不重复模式下名单已被抽空（本次抽到最后一人，或开抽前就已空） */
  exhausted: boolean
}

/**
 * 解析名单：按行拆分，去掉首尾空白与空行，重复姓名只留第一个。
 *
 * @param text 输入文本（每行一个，也兼容逗号、顿号、分号、制表符分隔）
 * @returns 名单
 * @example parseNames('张三\n李四\n张三') // ['张三', '李四']
 */
export function parseNames(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\r\n,，、;；\t]+/)) {
    const n = raw.trim()
    if (n && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

/**
 * 抽签：从候选里不放回地随机抽 count 个。
 *
 * @param names 名单
 * @param count 抽几个（1~MAX_PICK，超过候选数时抽完为止）
 * @param noRepeat 是否不重复（已抽过的不再进入候选）
 * @param used 已抽过的人（不重复模式用）
 * @param rand 随机函数（可注入）
 * @returns 抽签结果
 * @example drawNames(['a', 'b', 'c'], 2, true, [], () => 0) // picked: ['a', 'b']
 */
export function drawNames(names: readonly string[], count: number, noRepeat: boolean, used: readonly string[] = [], rand: Rand = Math.random): DrawResult {
  const usedSet = new Set(used)
  const pool = noRepeat ? names.filter((n) => !usedSet.has(n)) : names.slice()
  const want = Math.max(0, Math.min(Math.floor(count), MAX_PICK, pool.length))
  const picked: string[] = []
  for (let i = 0; i < want; i++) {
    const j = i + Math.min(pool.length - i - 1, Math.floor(rand() * (pool.length - i)))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
    picked.push(pool[i])
  }
  if (!noRepeat) return { picked, used: [...used], left: names.length, exhausted: false }
  const nextUsed = [...used, ...picked]
  const left = names.filter((n) => !new Set(nextUsed).has(n)).length
  return { picked, used: nextUsed, left, exhausted: left === 0 }
}

/**
 * 读取已存名单，失败返回空串。
 *
 * @returns 名单原文
 */
export function loadNames(): string {
  try {
    return localStorage.getItem(NAMES_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * 保存名单原文，失败静默忽略。
 *
 * @param text 名单原文
 * @returns 是否写入成功
 */
export function saveNames(text: string): boolean {
  try {
    localStorage.setItem(NAMES_KEY, text)
    return true
  } catch {
    return false
  }
}
