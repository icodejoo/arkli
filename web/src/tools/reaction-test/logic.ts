// 反应力测试：随机等待、成绩统计、等级评语、历史最好存持久缓存
import { createToolStorage, type ToolStorage } from '../../shared/toolStorage'

/** 工具持久缓存的命名空间 */
export const TOOL_NS = 'reaction-test'
/** 历史最好成绩的缓存键 */
export const BEST_STORE_KEY = 'best'

/** 旧版 localStorage 的 key（仅用于迁移） */
export const BEST_KEY = 'arkli:reaction-test:best'
/** 随机等待下限（毫秒） */
export const WAIT_MIN_MS = 1500
/** 随机等待上限（毫秒） */
export const WAIT_MAX_MS = 5000
/** 每组测试的轮数 */
export const ROUNDS = 5
/** 低于这个值基本不可能是人类反应，视为异常（毫秒） */
const SUSPICIOUS_MS = 80

/** 一档评语 */
export interface Grade {
  /** 反应时间上限（毫秒，不含） */
  below: number
  /** 称号 */
  title: string
  /** 评语 */
  comment: string
}

/** 评语档位，按 below 从小到大 */
export const GRADES: readonly Grade[] = [
  { below: 150, title: '神经闪电', comment: '快得不太像人，确定不是抢跑猜的？' },
  { below: 200, title: '电竞选手', comment: '反应很猛，手速在线。' },
  { below: 250, title: '身手敏捷', comment: '比大多数人都快，漂亮。' },
  { below: 300, title: '正常水平', comment: '健康的普通人反应，稳。' },
  { below: 400, title: '有点慢热', comment: '再来几次，热热手。' },
  { below: Infinity, title: '还没睡醒', comment: '喝口水，清醒一下再战。' },
]

/**
 * 随机等待时长，落在 [WAIT_MIN_MS, WAIT_MAX_MS) 内。
 *
 * @param rand 返回 [0,1) 的随机函数，默认 Math.random（测试可注入）
 * @returns 等待毫秒数（整数）
 * @example
 * randomWait(() => 0) // 1500
 */
export function randomWait(rand: () => number = Math.random): number {
  return WAIT_MIN_MS + Math.floor(rand() * (WAIT_MAX_MS - WAIT_MIN_MS))
}

/**
 * 根据平均反应时间给出评语。
 *
 * @param ms 反应时间（毫秒）
 * @returns 对应档位；非法值（NaN、负数）当作最慢档
 * @example
 * gradeFor(180).title // '电竞选手'
 */
export function gradeFor(ms: number): Grade {
  const v = Number.isFinite(ms) && ms >= 0 ? ms : Infinity
  return GRADES.find((g) => v < g.below) ?? GRADES[GRADES.length - 1]
}

/** 一组成绩的统计 */
export interface Stats {
  /** 有效轮数 */
  count: number
  /** 平均（毫秒，取整），无有效成绩为 0 */
  average: number
  /** 最好（毫秒，取整），无有效成绩为 0 */
  best: number
  /** 最差（毫秒，取整），无有效成绩为 0 */
  worst: number
}

/**
 * 统计一组成绩，只算有限的非负值，犯规的轮次由调用方不传入。
 *
 * @param times 各轮反应时间（毫秒）
 * @returns 平均、最好、最差
 * @example
 * summarize([200, 300]) // { count: 2, average: 250, best: 200, worst: 300 }
 */
export function summarize(times: number[]): Stats {
  const ok = times.filter((t) => Number.isFinite(t) && t >= 0)
  if (!ok.length) return { count: 0, average: 0, best: 0, worst: 0 }
  const sum = ok.reduce((a, b) => a + b, 0)
  return { count: ok.length, average: Math.round(sum / ok.length), best: Math.round(Math.min(...ok)), worst: Math.round(Math.max(...ok)) }
}

/**
 * 反应时间是否低得不合常理（可能是抢跑猜中或时钟异常）。
 *
 * @param ms 反应时间（毫秒）
 * @returns 低于 80ms 为 true
 * @example
 * isSuspicious(50) // true
 */
export function isSuspicious(ms: number): boolean {
  return ms < SUSPICIOUS_MS
}

/**
 * 是否刷新了历史最好（best 为 null 表示没有历史）。
 *
 * @param ms 本次成绩（毫秒）
 * @param best 历史最好
 * @returns 本次更快且有效时为 true
 * @example
 * isNewBest(190, 200) // true
 */
export function isNewBest(ms: number, best: number | null): boolean {
  return Number.isFinite(ms) && ms > 0 && (best === null || ms < best)
}

/**
 * 读取历史最好成绩，读失败或数据异常返回 null；首次读取时迁移旧键。
 *
 * @param store 持久缓存，默认本工具命名空间
 * @returns 毫秒数或 null
 * @example
 * const best = loadBest()
 */
export function loadBest(store: ToolStorage = createToolStorage(TOOL_NS)): number | null {
  store.adoptLegacy(BEST_KEY, BEST_STORE_KEY)
  const v = Number(store.get<unknown>(BEST_STORE_KEY, null))
  return Number.isFinite(v) && v > 0 ? v : null
}

/**
 * 保存历史最好成绩，失败时静默忽略。
 *
 * @param ms 毫秒数
 * @param store 持久缓存，默认本工具命名空间
 * @returns 是否写入成功
 * @example
 * saveBest(210)
 */
export function saveBest(ms: number, store: ToolStorage = createToolStorage(TOOL_NS)): boolean {
  return store.set(BEST_STORE_KEY, Math.round(ms))
}
