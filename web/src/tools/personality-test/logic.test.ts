import { describe, expect, it } from 'vitest'
import { DIMS, DIM_INFO, QUESTIONS, SCALE, TYPES } from './data'
import {
  answeredCount,
  BORDER_THRESHOLD,
  computeResult,
  dimResult,
  DIM_MAX,
  formatResultText,
  NEUTRAL,
  scoreDim,
  typeByCode,
} from './logic'

/** 按类型码构造答案：倾向码内字母的题答 hi，否则答 lo */
function answersFor(code: string, hi = 5, lo = 1): number[] {
  return QUESTIONS.map((q) => (code.includes(q.agree) ? hi : lo))
}

describe('题库与类型数据', () => {
  it('共 28 题，每维度 7 题，倾向字母合法', () => {
    expect(QUESTIONS).toHaveLength(28)
    for (const d of DIMS) {
      const qs = QUESTIONS.filter((q) => q.dim === d)
      expect(qs).toHaveLength(7)
      expect(qs.every((q) => q.agree === DIM_INFO[d].first || q.agree === DIM_INFO[d].second)).toBe(true)
      expect(qs.some((q) => q.agree === DIM_INFO[d].first)).toBe(true)
      expect(qs.some((q) => q.agree === DIM_INFO[d].second)).toBe(true)
    }
  })
  it('题干不重复', () => {
    expect(new Set(QUESTIONS.map((q) => q.text)).size).toBe(28)
  })
  it('16 种类型码、名称各不相同，覆盖全部组合', () => {
    expect(TYPES).toHaveLength(16)
    expect(new Set(TYPES.map((t) => t.code)).size).toBe(16)
    expect(new Set(TYPES.map((t) => t.name)).size).toBe(16)
    for (const a of 'EI') for (const b of 'SN') for (const c of 'TF') for (const d of 'JP') expect(typeByCode(a + b + c + d)).toBeTruthy()
  })
  it('描述 60~100 字，优缺点各 2 条', () => {
    for (const t of TYPES) {
      const n = [...t.desc].length
      expect(n, t.code).toBeGreaterThanOrEqual(60)
      expect(n, t.code).toBeLessThanOrEqual(100)
      expect(t.pros).toHaveLength(2)
      expect(t.cons).toHaveLength(2)
    }
  })
  it('文案里不出现受商标保护的字样', () => {
    const all = JSON.stringify([QUESTIONS, TYPES, DIM_INFO, SCALE]).toLowerCase()
    expect(all).not.toContain('mbti')
  })
  it('量表 1~5 且 3 为中立', () => {
    expect(SCALE.map((s) => s.value)).toEqual([1, 2, 3, 4, 5])
    expect(NEUTRAL).toBe(3)
  })
})

describe('answeredCount', () => {
  it('只数 1~5 的整数', () => {
    expect(answeredCount([5, 0, 3, undefined, 6, 2.5])).toBe(2)
  })
})

describe('scoreDim / dimResult', () => {
  it('全答中立得 0', () => {
    for (const d of DIMS) expect(scoreDim(d, Array(28).fill(3))).toBe(0)
  })
  it('极端答案得满分', () => {
    expect(scoreDim('EI', answersFor('ESTJ'))).toBe(DIM_MAX)
    expect(scoreDim('EI', answersFor('ISTJ'))).toBe(-DIM_MAX)
  })
  it('偏向与字母', () => {
    expect(dimResult('EI', 6)).toMatchObject({ letter: 'E', tie: false, borderline: false, percentFirst: 71 })
    expect(dimResult('EI', -6).letter).toBe('I')
  })
  it('各半时取 second 端并标记 tie 与 borderline', () => {
    expect(dimResult('JP', 0)).toMatchObject({ letter: 'P', tie: true, borderline: true, percentFirst: 50 })
  })
  it('边界阈值', () => {
    expect(dimResult('TF', BORDER_THRESHOLD).borderline).toBe(true)
    expect(dimResult('TF', BORDER_THRESHOLD + 1).borderline).toBe(false)
    expect(dimResult('TF', -(BORDER_THRESHOLD + 1)).borderline).toBe(false)
  })
})

describe('computeResult', () => {
  it('16 种类型都能由对应答案算回自己', () => {
    for (const t of TYPES) {
      const r = computeResult(answersFor(t.code))
      expect(r?.code).toBe(t.code)
      expect(r?.type.name).toBe(t.name)
      expect(r?.hasBorderline).toBe(false)
    }
  })
  it('未答完返回 null', () => {
    expect(computeResult(Array(27).fill(5))).toBeNull()
    expect(computeResult([])).toBeNull()
  })
  it('全中立：四维都 tie，落到 INFP 并提示接近中间', () => {
    const r = computeResult(Array(28).fill(3))
    expect(r?.code).toBe('INFP')
    expect(r?.dims.every((d) => d.tie)).toBe(true)
    expect(r?.hasBorderline).toBe(true)
  })
  it('轻微倾向会被标为接近中间', () => {
    // 把 E/I 维度全部答成「比较同意」倾向 E：每题偏 1，得分 ±7 以内
    const a = answersFor('ESTJ', 5, 1)
    QUESTIONS.forEach((q, i) => {
      if (q.dim === 'EI') a[i] = q.agree === 'E' ? 4 : 3
    })
    const r = computeResult(a)
    expect(r?.dims[0].letter).toBe('E')
    expect(r?.dims[0].score).toBe(4)
    expect(r?.dims[0].borderline).toBe(false)
    a[0] = 3
    a[1] = 3
    expect(computeResult(a)?.dims[0].score).toBe(2)
    expect(computeResult(a)?.dims[0].borderline).toBe(true)
    expect(computeResult(a)?.hasBorderline).toBe(true)
  })
})

describe('typeByCode', () => {
  it('查得到与查不到', () => {
    expect(typeByCode('ENTJ')?.name).toBe('谋局者')
    expect(typeByCode('XXXX')).toBeUndefined()
  })
})

describe('formatResultText', () => {
  it('含类型、各维度与免责声明', () => {
    const r = computeResult(answersFor('ENTJ'))!
    const text = formatResultText(r)
    expect(text).toContain('ENTJ 谋局者')
    expect(text).toContain('能量来源：外向 100% / 内向 0%')
    expect(text).toContain('仅供娱乐')
  })
  it('接近中间的维度有标注', () => {
    const text = formatResultText(computeResult(Array(28).fill(3))!)
    expect(text).toContain('（接近中间）')
  })
})
