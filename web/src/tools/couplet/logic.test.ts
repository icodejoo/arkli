import { describe, expect, it } from 'vitest'
import { COUPLETS, THEMES, type Couplet } from './data'
import {
  BANNER_LEN,
  BG_COLOR,
  customWarnings,
  drawCouplet,
  filterByLength,
  findDuplicates,
  GOLD_COLOR,
  LENGTH_OPTIONS,
  LEVEL_ENDINGS,
  layoutCouplet,
  OBLIQUE_ENDINGS,
  randomCouplet,
  THEME_IDS,
  themeCouplets,
  toneOf,
  validateCouplet,
  type CoupletCtx,
} from './logic'

/** 全库平铺 */
const ALL = THEME_IDS.flatMap((t) => COUPLETS[t])

describe('句库', () => {
  it('六个主题齐全，每个至少 12 副', () => {
    expect(THEMES).toHaveLength(6)
    for (const t of THEME_IDS) expect(themeCouplets(t).length, t).toBeGreaterThanOrEqual(12)
  })
  it('每副都通过校验（等长、横批 4 字、上仄下平收尾、同位不同字）', () => {
    for (const p of ALL) expect(validateCouplet(p), p.up).toEqual([])
  })
  it('全库上下联无重复', () => {
    expect(findDuplicates(ALL)).toEqual([])
  })
  it('字数只有 4 / 5 / 7，且各主题都有七言', () => {
    for (const p of ALL) expect(LENGTH_OPTIONS).toContain([...p.up].length)
    for (const t of THEME_IDS) expect(filterByLength(COUPLETS[t], 7).length, t).toBeGreaterThan(0)
  })
  it('平仄字表不互相矛盾', () => {
    for (const ch of OBLIQUE_ENDINGS) expect(LEVEL_ENDINGS.indexOf(ch), ch).toBe(-1)
  })
  it('上下联不含标点和空白', () => {
    for (const p of ALL) expect(/[\s，。,.]/.test(p.up + p.down + p.banner)).toBe(false)
  })
})

describe('toneOf', () => {
  it('认得登记过的字', () => {
    expect(toneOf('欢')).toBe('平')
    expect(toneOf('岁')).toBe('仄')
  })
  it('未登记返回 null', () => {
    expect(toneOf('龘')).toBeNull()
    expect(toneOf('')).toBeNull()
  })
})

describe('validateCouplet', () => {
  it('通过的返回空数组', () => {
    expect(validateCouplet({ up: '风调雨顺', down: '国泰民安', banner: '五谷丰登' })).toEqual([])
  })
  it('长度不等', () => {
    expect(validateCouplet({ up: '风调雨顺', down: '国泰民', banner: '五谷丰登' })).toContain('上下联字数不等')
  })
  it('横批不是四字', () => {
    expect(validateCouplet({ up: '风调雨顺', down: '国泰民安', banner: '五谷' })[0]).toContain('横批')
  })
  it('平仄反了', () => {
    const r = validateCouplet({ up: '国泰民安', down: '风调雨顺', banner: '五谷丰登' })
    expect(r).toContain('上联未以仄声收尾')
    expect(r).toContain('下联未以平声收尾')
  })
  it('收尾字没登记会提示', () => {
    expect(validateCouplet({ up: '风调雨龘', down: '国泰民安', banner: '五谷丰登' })).toContain('上联收尾字未登记平仄')
  })
  it('同位置同字', () => {
    expect(validateCouplet({ up: '风调雨顺', down: '风泰民安', banner: '五谷丰登' })).toContain('第 1 字上下联相同')
  })
  it('横批常量为 4', () => {
    expect(BANNER_LEN).toBe(4)
  })
})

describe('findDuplicates', () => {
  it('找出重复句', () => {
    const a: Couplet = { up: '甲', down: '乙', banner: '丙丁戊己' }
    const b: Couplet = { up: '甲', down: '庚', banner: '丙丁戊己' }
    expect(findDuplicates([a, b])).toEqual(['甲'])
    expect(findDuplicates([a])).toEqual([])
  })
})

describe('filterByLength / randomCouplet', () => {
  const list = COUPLETS.spring
  it('按字数筛选', () => {
    expect(filterByLength(list, 5).every((p) => [...p.up].length === 5)).toBe(true)
    expect(filterByLength(list, 0)).toHaveLength(list.length)
    expect(filterByLength(list, 9)).toEqual([])
  })
  it('随机源可注入', () => {
    expect(randomCouplet(list, null, () => 0)).toBe(list[0])
  })
  it('换一副不会拿到同一副', () => {
    for (let i = 0; i < 30; i++) expect(randomCouplet(list, list[0])?.up).not.toBe(list[0].up)
  })
  it('只有一副时没得换，空列表返回 null', () => {
    expect(randomCouplet([list[0]], list[0])).toBe(list[0])
    expect(randomCouplet([])).toBeNull()
  })
})

describe('customWarnings', () => {
  it('合规无提示', () => {
    expect(customWarnings('风调雨顺', '国泰民安', '五谷丰登')).toEqual([])
  })
  it('字数、横批、平仄提示', () => {
    expect(customWarnings('风调雨顺', '国泰民', '五谷')).toEqual(expect.arrayContaining(['上下联字数不一致']))
    expect(customWarnings('风调雨顺', '国泰民安', '五谷')).toEqual(['横批一般是 4 字'])
    expect(customWarnings('国泰民安', '风调雨顺', '')).toEqual(['传统上上联以仄声收尾', '传统上下联以平声收尾'])
    expect(customWarnings('一'.repeat(17), '二'.repeat(17), '')[0]).toContain('最多')
  })
})

describe('layoutCouplet', () => {
  it('上联在右、下联在左，竖排自上而下', () => {
    const l = layoutCouplet('春风', '秋雨', '')
    const up = l.items.filter((i) => '春风'.includes(i.ch))
    const down = l.items.filter((i) => '秋雨'.includes(i.ch))
    expect(up[0].x).toBeGreaterThan(down[0].x)
    expect(up[0].x).toBe(up[1].x)
    expect(up[1].y).toBeGreaterThan(up[0].y)
    expect(l.items).toHaveLength(4)
  })
  it('横批居中、从左到右，且有横批时画布更高', () => {
    const a = layoutCouplet('春风', '秋雨', '万象更新')
    const b = layoutCouplet('春风', '秋雨', '')
    const ban = a.items.slice(0, 4)
    expect(ban.map((i) => i.ch).join('')).toBe('万象更新')
    expect(ban[0].x).toBeLessThan(ban[3].x)
    expect((ban[0].x + ban[3].x) / 2).toBeCloseTo(a.width / 2)
    expect(a.height).toBeGreaterThan(b.height)
  })
  it('联句更长画布更高；所有字都在画布内', () => {
    const s = layoutCouplet('一二', '三四', '')
    const t = layoutCouplet('一二三四五六七', '八九十甲乙丙丁', '横批四字')
    expect(t.height).toBeGreaterThan(s.height)
    for (const i of t.items) {
      expect(i.x).toBeGreaterThan(0)
      expect(i.x).toBeLessThan(t.width)
      expect(i.y).toBeLessThan(t.height)
    }
  })
  it('两联不等长按较长的算高度', () => {
    expect(layoutCouplet('一二三', '四', '').height).toBe(layoutCouplet('一二三', '四五六', '').height)
  })
})

describe('drawCouplet', () => {
  it('先铺红底再画金字', () => {
    const calls: string[] = []
    const fills: string[] = []
    const ctx: Record<string, unknown> = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      font: '',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      fillRect() {
        calls.push('rect')
        fills.push(String(ctx.fillStyle))
      },
      strokeRect() {
        calls.push('stroke')
      },
      fillText(t: string) {
        calls.push('text:' + t)
        fills.push(String(ctx.fillStyle))
      },
    }
    drawCouplet(ctx as unknown as CoupletCtx, layoutCouplet('春风', '秋雨', ''))
    expect(calls.slice(0, 2)).toEqual(['rect', 'stroke'])
    expect(calls.filter((c) => c.startsWith('text:'))).toHaveLength(4)
    expect(fills[0]).toBe(BG_COLOR)
    expect(fills[1]).toBe(GOLD_COLOR)
    expect(ctx.textAlign).toBe('center')
  })
})
