import { describe, expect, it, vi } from 'vitest'
import { TEMPLATES, buildScene } from './scene'
import { drawScene, escapeXml, exportSize, renderLogoSvg, renderSvg } from './render'
import type { LogoParams } from './types'

/** 测试用基础参数 */
const BASE: LogoParams = { template: 'stack', palette: 'tech-blue', icon: 'coffee', name: '山屿咖啡', slogan: 'Slow Life', font: 'sans-bold', fontScale: 1, spacing: 0.04, invert: false }

describe('escapeXml', () => {
  it('转义 & < > 与引号', () => {
    expect(escapeXml(`A&B<C>"D"'E'`)).toBe('A&amp;B&lt;C&gt;&quot;D&quot;&apos;E&apos;')
  })
})

describe('renderSvg', () => {
  it('每个模板都能出合法的 SVG 外壳', () => {
    for (const t of TEMPLATES) {
      const svg = renderLogoSvg({ ...BASE, template: t.id })
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.endsWith('</svg>')).toBe(true)
      expect(svg).toContain(`viewBox="0 0 ${t.w} ${t.h}"`)
      expect(svg).not.toContain('NaN')
    }
  })

  it('品牌名里的特殊字符被转义，不会出现原始标签', () => {
    const svg = renderLogoSvg({ ...BASE, name: '<b>A&B</b>', slogan: '"x"' })
    expect(svg).not.toContain('<b>')
    expect(svg).toContain('&lt;b&gt;A&amp;B&lt;/b&gt;')
  })

  it('字体栈里的双引号不会破坏属性', () => {
    const svg = renderLogoSvg(BASE)
    expect(svg).toMatch(/font-family="[^"]*Noto Sans CJK SC[^"]*"/)
    expect(svg).toContain('font-family="&apos;Noto Sans CJK SC&apos;')
  })

  it('空图标不产出图标组', () => {
    expect(renderLogoSvg({ ...BASE, icon: '' })).not.toContain('<g transform')
    expect(renderLogoSvg(BASE)).toContain('<g transform')
  })
})

describe('exportSize', () => {
  it('长边定为指定像素并保持比例', () => {
    expect(exportSize({ w: 900, h: 420 }, 1800)).toEqual({ width: 1800, height: 840, scale: 2 })
  })
  it('过小的值被夹到下限', () => {
    expect(exportSize({ w: 600, h: 600 }, 0).width).toBe(64)
  })
})

describe('drawScene', () => {
  /** 记录调用的假 2D 上下文 */
  function fakeCtx() {
    const calls: string[] = []
    const proxy = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : (..._a: unknown[]) => void calls.push(k)),
      set: (t, k: string, v) => ((t[k] = v), true),
    })
    return { ctx: proxy as unknown as CanvasRenderingContext2D, calls }
  }

  it('每个模板都能画完，文字走 fillText', () => {
    vi.stubGlobal('Path2D', class {})
    for (const t of TEMPLATES) {
      const { ctx, calls } = fakeCtx()
      drawScene(ctx, buildScene({ ...BASE, template: t.id }))
      expect(calls).toContain('fillText')
      expect(calls.filter((c) => c === 'save').length).toBe(calls.filter((c) => c === 'restore').length)
    }
    vi.unstubAllGlobals()
  })

  it('renderSvg 与场景图元数量一致', () => {
    const scene = buildScene(BASE)
    const svg = renderSvg(scene)
    const count = (svg.match(/<(rect|circle|path|g|text)\b/g) ?? []).length
    // 外壳底色 rect 1 个 + 图标 g 内的 path 与 g 各算一个
    const icons = scene.items.filter((i) => i.k === 'icon').length
    expect(count).toBe(1 + scene.items.length + icons)
  })
})
