import { describe, expect, it, vi } from 'vitest'
import { drawScene, renderLogoSvg, renderSvg, sceneOf } from './render'
import { SYMBOL_LAYOUTS, SYMBOL_RATIO, buildSymbolScene } from './symbolScene'
import type { AiSymbol, LogoParams, SymbolItem } from './types'

/** 一个 512 坐标系的符号（两条带平移的 path） */
const SYMBOL: AiSymbol = { layout: 'ai-ring', vb: 512, paths: [{ d: 'M0 0 L100 0 L100 100 Z', tx: 200, ty: 150 }, { d: 'M0 0 L50 0 L50 50 Z', tx: 10.5, ty: 20 }] }
/** 测试用基础参数 */
const BASE: LogoParams = { template: 'stack', palette: 'tech-blue', icon: 'coffee', name: '山屿咖啡', slogan: 'Slow Life', font: 'sans-bold', fontScale: 1, spacing: 0.04, invert: false, symbol: SYMBOL }

/** 取场景里的符号图元 */
function symbolOf(p: LogoParams): SymbolItem {
  return buildSymbolScene(p).items.find((i): i is SymbolItem => i.k === 'symbol')!
}

describe('buildSymbolScene', () => {
  it('四种版式的画布尺寸：三种 600x600，横排 900x420', () => {
    const sizes = SYMBOL_LAYOUTS.map((l) => {
      const s = buildSymbolScene({ ...BASE, symbol: { ...SYMBOL, layout: l.id } })
      return [l.id, s.w, s.h]
    })
    expect(sizes).toEqual([['ai-ring', 600, 600], ['ai-solid', 600, 600], ['ai-square', 600, 600], ['ai-lockup', 900, 420]])
  })
  it('符号占容器 58%：圆环按内圆直径，方块按边长，并居中于容器', () => {
    const ring = buildSymbolScene(BASE)
    const inner = ring.items.filter((i) => i.k === 'circle')[1] as { cx: number; cy: number; r: number }
    const sym = symbolOf(BASE)
    expect(sym.size).toBeCloseTo(inner.r * 2 * SYMBOL_RATIO, 1)
    expect(sym.x + sym.size / 2).toBeCloseTo(inner.cx, 1)
    expect(sym.y + sym.size / 2).toBeCloseTo(inner.cy, 1)
    const sq = buildSymbolScene({ ...BASE, symbol: { ...SYMBOL, layout: 'ai-square' } })
    const rect = sq.items.find((i) => i.k === 'rect') as { x: number; y: number; w: number }
    const sSym = sq.items.find((i): i is SymbolItem => i.k === 'symbol')!
    expect(sSym.size).toBeCloseTo(rect.w * SYMBOL_RATIO, 1)
    expect(sSym.x + sSym.size / 2).toBeCloseTo(rect.x + rect.w / 2, 1)
    expect(sSym.y + sSym.size / 2).toBeCloseTo(rect.y + rect.w / 2, 1)
  })
  it('实心圆：符号用底色（反白），圆环版式用主色', () => {
    const solid = symbolOf({ ...BASE, symbol: { ...SYMBOL, layout: 'ai-solid' } })
    const ring = symbolOf(BASE)
    expect(solid.color).not.toBe(ring.color)
  })
  it('横排：容器在左、文字在右（start 对齐），整体在画布内', () => {
    const s = buildSymbolScene({ ...BASE, symbol: { ...SYMBOL, layout: 'ai-lockup' } })
    const sym = s.items.find((i): i is SymbolItem => i.k === 'symbol')!
    const texts = s.items.filter((i) => i.k === 'text') as Array<{ x: number; anchor: string }>
    expect(texts.length).toBe(2)
    expect(texts.every((t) => t.anchor === 'start' && t.x > sym.x + sym.size)).toBe(true)
    expect(sym.x).toBeGreaterThan(0)
  })
  it('文字都在画布内：很长的名字与标语基线不越界', () => {
    const s = buildSymbolScene({ ...BASE, name: '这是一个很长很长很长的品牌名字', slogan: '这也是一句很长很长的标语文案' })
    for (const t of s.items.filter((i) => i.k === 'text') as Array<{ y: number }>) expect(t.y).toBeLessThanOrEqual(s.h)
  })
  it('没有标语时不出标语文字；没有符号路径时只画容器与文字', () => {
    expect(buildSymbolScene({ ...BASE, slogan: '' }).items.filter((i) => i.k === 'text')).toHaveLength(1)
    const empty = buildSymbolScene({ ...BASE, symbol: { ...SYMBOL, paths: [] } })
    expect(empty.items.some((i) => i.k === 'symbol')).toBe(false)
  })
  it('反色与自定义主色生效', () => {
    expect(buildSymbolScene({ ...BASE, invert: true }).bg).not.toBe(buildSymbolScene(BASE).bg)
    expect(symbolOf({ ...BASE, primaryOverride: '#ff0000' }).color).toBe('#ff0000')
  })
  it('sceneOf：有 symbol 走符号版式，没有走模板', () => {
    expect(sceneOf(BASE).items.some((i) => i.k === 'symbol')).toBe(true)
    expect(sceneOf({ ...BASE, symbol: undefined }).items.some((i) => i.k === 'symbol')).toBe(false)
  })
})

describe('SVG 后端', () => {
  it('符号输出一个缩放组 + 每条 path 带自己的平移，单色填充', () => {
    const svg = renderLogoSvg(BASE)
    const sym = symbolOf(BASE)
    const k = Math.round((sym.size / 512) * 10000) / 10000
    expect(svg).toContain(`<g transform="translate(${sym.x} ${sym.y}) scale(${k})" fill="${sym.color}">`)
    expect(svg).toContain('<path d="M0 0 L100 0 L100 100 Z" transform="translate(200 150)"/>')
    expect(svg).toContain('<path d="M0 0 L50 0 L50 50 Z" transform="translate(10.5 20)"/>')
    expect(svg).not.toContain('NaN')
  })
  it('d 里的特殊字符被转义（纵深防御）', () => {
    const svg = renderSvg({ w: 10, h: 10, bg: '#fff', items: [{ k: 'symbol', paths: [{ d: 'M0 0"><script>', tx: 0, ty: 0 }], vb: 512, x: 0, y: 0, size: 5, color: '#000' }] })
    expect(svg).not.toContain('<script>')
  })
})

describe('Canvas 后端', () => {
  /** 记录调用与参数的假 2D 上下文 */
  function fakeCtx() {
    const calls: Array<[string, unknown[]]> = []
    const proxy = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => void calls.push([k, a])),
      set: (t, k: string, v) => ((t[k] = v), true),
    })
    return { ctx: proxy as unknown as CanvasRenderingContext2D, calls }
  }
  it('先平移缩放到容器，再逐条路径平移并用 Path2D 填充；save/restore 配平', () => {
    const made: string[] = []
    vi.stubGlobal('Path2D', class { constructor(d?: string) { made.push(d ?? '') } })
    const { ctx, calls } = fakeCtx()
    const scene = buildSymbolScene(BASE)
    const sym = scene.items.find((i): i is SymbolItem => i.k === 'symbol')!
    drawScene(ctx, scene)
    expect(made).toEqual(expect.arrayContaining(['M0 0 L100 0 L100 100 Z', 'M0 0 L50 0 L50 50 Z']))
    const k = sym.size / 512
    expect(calls).toContainEqual(['translate', [sym.x, sym.y]])
    expect(calls).toContainEqual(['scale', [k, k]])
    expect(calls).toContainEqual(['translate', [200, 150]])
    expect(calls).toContainEqual(['translate', [10.5, 20]])
    expect(calls.filter((c) => c[0] === 'fill').length).toBeGreaterThanOrEqual(2)
    expect(calls.filter((c) => c[0] === 'save').length).toBe(calls.filter((c) => c[0] === 'restore').length)
    vi.unstubAllGlobals()
  })
  it('四种版式都能画完', () => {
    vi.stubGlobal('Path2D', class {})
    for (const l of SYMBOL_LAYOUTS) {
      const { ctx, calls } = fakeCtx()
      drawScene(ctx, buildSymbolScene({ ...BASE, symbol: { ...SYMBOL, layout: l.id } }))
      expect(calls.some((c) => c[0] === 'fillText')).toBe(true)
    }
    vi.unstubAllGlobals()
  })
})
