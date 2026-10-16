import { describe, expect, it } from 'vitest'
import { BANNER_LEN, BG_COLOR, customWarnings, drawCouplet, GOLD_COLOR, layoutCouplet, type CoupletCtx } from './logic'
import { LEVEL_ENDINGS, OBLIQUE_ENDINGS, toneOf } from './tone'

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

describe('平仄字表', () => {
  it('平仄字表不互相矛盾', () => {
    expect([...LEVEL_ENDINGS].filter((c) => OBLIQUE_ENDINGS.includes(c))).toEqual([])
  })
  it('横批常量为 4', () => {
    expect(BANNER_LEN).toBe(4)
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
