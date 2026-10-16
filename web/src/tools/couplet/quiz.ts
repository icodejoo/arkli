// 出上联（语料来源）：按字数从语料池里抽一副，不合字数的跳过。纯逻辑，取语料的函数由调用方注入。
import type { CorpusCouplet } from '@/native/corpus'
import { hanCount, UPPER_LEN_ANY } from './generate'
import { nextDraw, type PoolCursor } from './cursor'

/** 为凑字数最多连抽几副（稀有字数抽不到就放弃，别卡住界面） */
export const QUIZ_MAX_DRAWS = 60

/** 一次抽取的结果 */
export interface QuizDraw {
  /** 抽中的对联 */
  couplet: CorpusCouplet
  /** 抽完后的游标，调用方负责存盘 */
  cursor: PoolCursor
  /** 本轮还剩几副 */
  remaining: number
}

/**
 * 按字数抽一副对联：连续抽取，直到上联汉字数符合要求或用尽 {@link QUIZ_MAX_DRAWS} 次。
 *
 * @param cursor 池游标，没有为 null
 * @param n 池大小
 * @param v 语料总条数
 * @param len 要求的上联汉字数，{@link UPPER_LEN_ANY} 不限
 * @param get 按池内下标取一副的函数
 * @returns 抽中的结果；池为空或没凑到字数返回 null
 * @example const d = await drawByLength(loadCursor(k), p.count, total, 7, (i) => corpusGet(p.pool, i))
 */
export async function drawByLength(
  cursor: PoolCursor | null,
  n: number,
  v: number,
  len: number,
  get: (index: number) => Promise<CorpusCouplet>,
): Promise<QuizDraw | null> {
  let cur = cursor
  for (let i = 0; i < QUIZ_MAX_DRAWS; i++) {
    const d = nextDraw(cur, n, v)
    if (!d) return null
    const c = await get(d.index)
    cur = d.cursor
    if (len === UPPER_LEN_ANY || hanCount(c.up) === len) return { couplet: c, cursor: d.cursor, remaining: d.remaining }
  }
  return null
}
