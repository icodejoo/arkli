import { describe, expect, it } from 'vitest'
import { BANNER_LEN, BG_COLOR, COUPLET_SPEC, customWarnings, drawCouplet, INK_COLOR, layoutCouplet, MOURNING_BG_COLOR, type CoupletCtx } from './logic'
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
  it('挽联：白底黑字、没有福字，尺寸与普通对联一致', () => {
    const m = layoutCouplet('春风', '秋雨', '', true)
    const n = layoutCouplet('春风', '秋雨', '')
    expect(m.fu).toBeNull()
    expect(m.theme).toMatchObject({ bg: MOURNING_BG_COLOR, ink: INK_COLOR })
    expect(m.theme.border).not.toBe('')
    expect(n.theme).toEqual({ bg: BG_COLOR, ink: INK_COLOR, border: '' })
    expect([m.width, m.height]).toEqual([n.width, n.height])
  })
  it('上联在右、下联在左，竖排自上而下', () => {
    const l = layoutCouplet('春风', '秋雨', '')
    const up = l.items.filter((i) => '春风'.includes(i.ch))
    const down = l.items.filter((i) => '秋雨'.includes(i.ch))
    expect(up[0].x).toBeGreaterThan(down[0].x)
    expect(up[0].x).toBe(up[1].x)
    expect(up[1].y).toBeGreaterThan(up[0].y)
    expect(l.items).toHaveLength(4)
  })
  it('牌匾在上方居中，福字在两联正中间', () => {
    const l = layoutCouplet('春风', '秋雨', '万象更新')
    expect(l.plaque.x + l.plaque.w / 2).toBeCloseTo(l.width / 2)
    expect(l.plaque.y + l.plaque.h).toBeLessThan(l.upper.y)
    expect(l.fu!.x).toBeCloseTo(l.width / 2)
    expect(l.fu!.x).toBeGreaterThan(l.lower.x + l.lower.w)
    expect(l.fu!.x).toBeLessThan(l.upper.x)
    expect(l.banner.text).toBe('万象更新')
  })
  it('联句短时尺寸固定，更长时联条变高；所有字都在联条内', () => {
    const s = layoutCouplet('一二', '三四', '')
    const e = layoutCouplet('', '', '')
    const t = layoutCouplet('一二三四五六七八九十甲乙丙丁', '一二三四五六七八九十甲乙丙丁', '横批四字')
    expect(s.height).toBe(e.height)
    expect(s.upper.h).toBe(COUPLET_SPEC.minHeight)
    expect(t.upper.h).toBeGreaterThan(s.upper.h)
    for (const i of t.items) {
      expect(i.y).toBeGreaterThan(t.upper.y)
      expect(i.y).toBeLessThan(t.upper.y + t.upper.h)
    }
  })
  it('两联不等长按较长的算高度，各自垂直居中', () => {
    const l = layoutCouplet('一二三四五六七八九十甲乙丙', '壹', '')
    expect(l.upper.h).toBe(l.lower.h)
    const d = l.items.find((i) => i.ch === '壹')!
    expect(d.y).toBeCloseTo(l.lower.y + l.lower.h / 2)
  })
})

/** 造一个记录调用的假绘图目标 */
function fakeCtx(calls: string[], fills: string[]): CoupletCtx {
  const ctx: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    strokeRect() {
      calls.push('stroke')
    },
    fillRect() {
      calls.push('rect')
      fills.push(String(ctx.fillStyle))
    },
    fillText(t: string) {
      calls.push('text:' + t)
      fills.push(String(ctx.fillStyle))
    },
  }
  return ctx as unknown as CoupletCtx
}

describe('drawCouplet', () => {
  it('先铺红底块再画福字，最后画墨色字', () => {
    const calls: string[] = []
    const fills: string[] = []
    const ctx = fakeCtx(calls, fills)
    drawCouplet(ctx, layoutCouplet('春风', '秋雨', '万象更新'))
    expect(calls.slice(0, 4)).toEqual(['rect', 'rect', 'rect', 'rect'])
    expect(calls.filter((c) => c.startsWith('text:'))).toEqual(['text:福', 'text:万象更新', 'text:春', 'text:风', 'text:秋', 'text:雨'])
    expect(fills[0]).toBe(BG_COLOR)
    expect(fills[4]).toBe(INK_COLOR)
    expect(ctx.textAlign).toBe('center')
  })
  it('没有横批就不画横批文字', () => {
    const calls: string[] = []
    drawCouplet(fakeCtx(calls, []), layoutCouplet('春', '秋', ''))
    expect(calls.filter((c) => c.startsWith('text:'))).toEqual(['text:福', 'text:春', 'text:秋'])
  })
  it('挽联：白底、描边、不画福字', () => {
    const calls: string[] = []
    const fills: string[] = []
    drawCouplet(fakeCtx(calls, fills), layoutCouplet('春', '秋', '', true))
    expect(fills[0]).toBe(MOURNING_BG_COLOR)
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(3)
    expect(calls.filter((c) => c.startsWith('text:'))).toEqual(['text:春', 'text:秋'])
  })
})
