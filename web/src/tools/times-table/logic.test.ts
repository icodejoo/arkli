import { describe, expect, it } from 'vitest'
import { accuracy, CHOICE_COUNT, emptyStats, makeOptions, makeQuestion, parseAnswer, recordAnswer } from './logic'

/** 可复现的伪随机 */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('makeQuestion', () => {
  it('乘数在 1~max，答案正确', () => {
    for (const max of [9, 12]) {
      const r = seeded(max)
      for (let i = 0; i < 300; i++) {
        const q = makeQuestion(max, r)
        expect(q.a).toBeGreaterThanOrEqual(1)
        expect(q.a).toBeLessThanOrEqual(max)
        expect(q.b).toBeGreaterThanOrEqual(1)
        expect(q.b).toBeLessThanOrEqual(max)
        expect(q.answer).toBe(q.a * q.b)
      }
    }
  })
  it('注入固定随机可得固定题，边界可达', () => {
    expect(makeQuestion(9, () => 0)).toMatchObject({ a: 1, b: 1, answer: 1 })
    expect(makeQuestion(9, () => 0.999999)).toMatchObject({ a: 9, b: 9, answer: 81 })
  })
  it('避开与上一题相同', () => {
    const q = makeQuestion(9, () => 0, { a: 1, b: 1 })
    expect(`${q.a}x${q.b}`).not.toBe('1x1')
  })
})

describe('makeOptions', () => {
  it('四个互不相同的正整数且含答案（全表扫描）', () => {
    const r = seeded(42)
    for (let a = 1; a <= 12; a++) {
      for (let b = 1; b <= 12; b++) {
        const o = makeOptions(a, b, r)
        expect(o).toHaveLength(CHOICE_COUNT)
        expect(new Set(o).size).toBe(CHOICE_COUNT)
        expect(o).toContain(a * b)
        expect(o.every((v) => Number.isInteger(v) && v > 0)).toBe(true)
      }
    }
  })
})

describe('recordAnswer', () => {
  const q = { a: 7, b: 8, answer: 56 }
  it('答对累计连对与最长连对', () => {
    let s = recordAnswer(emptyStats(), q, 56)
    s = recordAnswer(s, q, 56)
    expect(s).toMatchObject({ total: 2, correct: 2, streak: 2, bestStreak: 2 })
    s = recordAnswer(s, q, 54)
    expect(s).toMatchObject({ total: 3, correct: 2, streak: 0, bestStreak: 2 })
  })
  it('答错进错题本，同题累计次数并更新最近作答', () => {
    let s = recordAnswer(emptyStats(), q, 54)
    s = recordAnswer(s, q, null)
    expect(s.wrong).toEqual([{ a: 7, b: 8, answer: 56, given: null, times: 2 }])
    s = recordAnswer(s, { a: 3, b: 4, answer: 12 }, 7)
    expect(s.wrong).toHaveLength(2)
  })
  it('不修改旧统计', () => {
    const old = emptyStats()
    recordAnswer(old, q, 1)
    expect(old).toEqual(emptyStats())
  })
})

describe('accuracy / parseAnswer', () => {
  it('正确率', () => {
    expect(accuracy(emptyStats())).toBe(0)
    expect(accuracy({ ...emptyStats(), total: 4, correct: 3 })).toBe(75)
  })
  it('解析输入', () => {
    expect(parseAnswer(' 56 ')).toBe(56)
    expect(parseAnswer('')).toBeNull()
    expect(parseAnswer('5a')).toBeNull()
    expect(parseAnswer('-3')).toBeNull()
  })
})
