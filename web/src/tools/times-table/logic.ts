// 九九乘法练习：出题、四选一选项、答题统计与错题本（随机函数可注入）

/** 随机函数：返回 [0,1) */
export type Rand = () => number

/** 可选的乘数上限 */
export const MAX_OPTIONS: readonly number[] = [9, 12]
/** 选项个数 */
export const CHOICE_COUNT = 4

/** 一道题 */
export interface Question {
  /** 乘数 a */
  a: number
  /** 乘数 b */
  b: number
  /** 正确答案 */
  answer: number
  /** 四选一选项（含答案，已打乱） */
  options: number[]
}

/** 一条错题 */
export interface WrongItem {
  /** 乘数 a */
  a: number
  /** 乘数 b */
  b: number
  /** 正确答案 */
  answer: number
  /** 最近一次的错误作答，空答案为 null */
  given: number | null
  /** 累计答错次数 */
  times: number
}

/** 练习统计 */
export interface Stats {
  /** 已答题数 */
  total: number
  /** 答对数 */
  correct: number
  /** 当前连续答对 */
  streak: number
  /** 本轮最长连对 */
  bestStreak: number
  /** 错题本 */
  wrong: WrongItem[]
}

/**
 * 取 [min, max] 的随机整数。
 *
 * @param min 下界
 * @param max 上界
 * @param rand 随机函数
 * @returns 整数
 */
function randInt(min: number, max: number, rand: Rand): number {
  return min + Math.min(max - min, Math.floor(rand() * (max - min + 1)))
}

/**
 * 生成四选一选项：干扰项取常见错法（少/多一组、邻近乘积），不够再随机补。
 *
 * @param a 乘数 a
 * @param b 乘数 b
 * @param rand 随机函数
 * @returns 打乱后的 4 个互不相同的正整数选项（含答案）
 * @example makeOptions(7, 8, Math.random) // 如 [56, 49, 63, 54]
 */
export function makeOptions(a: number, b: number, rand: Rand = Math.random): number[] {
  const answer = a * b
  const set = new Set<number>([answer])
  const near = [answer - a, answer + a, answer - b, answer + b, answer - 1, answer + 1, answer + 2, answer - 2, answer + 10, answer - 10]
  // 先打乱常见干扰项再逐个收
  const pool = shuffle(near, rand).filter((v) => v > 0)
  for (const v of pool) {
    if (set.size >= CHOICE_COUNT) break
    set.add(v)
  }
  let guard = 0
  while (set.size < CHOICE_COUNT && guard++ < 200) set.add(randInt(1, Math.max(answer + 10, 20), rand))
  return shuffle([...set], rand)
}

/**
 * Fisher–Yates 洗牌，返回新数组。
 *
 * @param items 原数组
 * @param rand 随机函数
 * @returns 新数组
 */
function shuffle<T>(items: readonly T[], rand: Rand): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(0, i, rand)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * 出一道题，可避开上一题。
 *
 * @param max 乘数上限（1~max）
 * @param rand 随机函数（可注入）
 * @param prev 上一题，用来避免连续重复
 * @returns 题目
 * @example makeQuestion(9, () => 0.5)
 */
export function makeQuestion(max: number, rand: Rand = Math.random, prev?: Pick<Question, 'a' | 'b'>): Question {
  let a = randInt(1, max, rand)
  let b = randInt(1, max, rand)
  if (prev && max > 1 && a === prev.a && b === prev.b) {
    // 重复就把 b 顺延一位
    b = (b % max) + 1
  }
  return { a, b, answer: a * b, options: makeOptions(a, b, rand) }
}

/** 初始统计 */
export function emptyStats(): Stats {
  return { total: 0, correct: 0, streak: 0, bestStreak: 0, wrong: [] }
}

/**
 * 记录一次作答，返回新统计（答错进错题本，同题累计次数）。
 *
 * @param stats 当前统计
 * @param q 题目
 * @param given 作答；null 表示未作答/超时
 * @returns 新统计
 * @example recordAnswer(emptyStats(), makeQuestion(9), 12)
 */
export function recordAnswer(stats: Stats, q: Pick<Question, 'a' | 'b' | 'answer'>, given: number | null): Stats {
  const ok = given === q.answer
  const streak = ok ? stats.streak + 1 : 0
  const next: Stats = {
    total: stats.total + 1,
    correct: stats.correct + (ok ? 1 : 0),
    streak,
    bestStreak: Math.max(stats.bestStreak, streak),
    wrong: stats.wrong,
  }
  if (!ok) {
    const hit = stats.wrong.find((w) => w.a === q.a && w.b === q.b)
    next.wrong = hit
      ? stats.wrong.map((w) => (w === hit ? { ...w, given, times: w.times + 1 } : w))
      : [...stats.wrong, { a: q.a, b: q.b, answer: q.answer, given, times: 1 }]
  }
  return next
}

/**
 * 正确率百分比。
 *
 * @param stats 统计
 * @returns 0~100 整数；没答题为 0
 * @example accuracy({ ...emptyStats(), total: 4, correct: 3 }) // 75
 */
export function accuracy(stats: Stats): number {
  return stats.total ? Math.round((stats.correct / stats.total) * 100) : 0
}

/**
 * 解析输入框内容为整数。
 *
 * @param text 输入文本
 * @returns 整数；空或非法返回 null
 * @example parseAnswer(' 56 ') // 56
 */
export function parseAnswer(text: string): number | null {
  const t = text.trim()
  return /^\d{1,4}$/.test(t) ? Number(t) : null
}
