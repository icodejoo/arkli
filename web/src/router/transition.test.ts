import { describe, expect, it } from 'vitest'
import { holdScroll, isCachedRoute, isTabPath, pageTransition, releaseScroll, routeDepth } from './transition'

describe('isTabPath / routeDepth', () => {
  it('四个根 tab 为 0，工具页为 1', () => {
    for (const p of ['/', '', '/ai', '/favorites', '/settings']) {
      expect(isTabPath(p)).toBe(true)
      expect(routeDepth(p)).toBe(0)
    }
    expect(isTabPath('/tool/ruler')).toBe(false)
    expect(routeDepth('/tool/ruler')).toBe(1)
  })
})

describe('pageTransition', () => {
  it('tab 之间切换：淡入淡出', () => {
    expect(pageTransition('/ai', '/')).toBe('fade')
    expect(pageTransition('/', '/settings')).toBe('fade')
    expect(pageTransition('/favorites', '/ai')).toBe('fade')
  })

  it('AI 中心与 AI 应用二级页：进入推入、返回弹出', () => {
    expect(pageTransition('/ai/apps', '/ai')).toBe('push')
    expect(pageTransition('/ai', '/ai/apps')).toBe('pop')
  })
  it('tab → 工具页：推入', () => {
    expect(pageTransition('/tool/ruler', '/')).toBe('push')
    expect(pageTransition('/tool/ruler', '/favorites')).toBe('push')
  })
  it('工具页 → tab：弹出（含 replace 回首页的兜底）', () => {
    expect(pageTransition('/', '/tool/ruler')).toBe('pop')
    expect(pageTransition('/favorites', '/tool/ruler')).toBe('pop')
  })
  it('同层切换（深链从一个工具跳到另一个）和同一 tab 到自己：按推入', () => {
    expect(pageTransition('/tool/a', '/tool/b')).toBe('push')
    expect(pageTransition('/', '/')).toBe('push')
  })
})

describe('isCachedRoute', () => {
  it('四个根 tab 被缓存，工具页不缓存', () => {
    for (const n of ['home', 'ai', 'favorites', 'settings']) expect(isCachedRoute(n)).toBe(true)
    expect(isCachedRoute('tool')).toBe(false)
    expect(isCachedRoute(undefined)).toBe(false)
    expect(isCachedRoute(Symbol('x'))).toBe(false)
  })
})

/** 造一个能记录内联样式的元素替身 */
function fakeEl() {
  const props = new Map<string, string>()
  return {
    style: {
      top: '',
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
    },
    props,
  }
}

describe('holdScroll / releaseScroll', () => {
  it('有滚动量：top 取负值，并写入 --hold-scroll', () => {
    const el = fakeEl()
    holdScroll(el as unknown as HTMLElement, 320)
    expect(el.style.top).toBe('-320px')
    expect(el.props.get('--hold-scroll')).toBe('320px')
  })

  it('没有滚动：什么都不写', () => {
    const el = fakeEl()
    holdScroll(el as unknown as HTMLElement, 0)
    expect(el.style.top).toBe('')
    expect(el.props.size).toBe(0)
  })

  it('释放：清掉 top 与变量，被缓存的节点下次进来不会残留', () => {
    const el = fakeEl()
    holdScroll(el as unknown as HTMLElement, 480)
    releaseScroll(el as unknown as HTMLElement)
    expect(el.style.top).toBe('')
    expect(el.props.has('--hold-scroll')).toBe(false)
  })
})
