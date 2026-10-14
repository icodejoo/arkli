import { describe, expect, it } from 'vitest'
import { holdScroll, isCachedRoute, pageTransition, releaseScroll, routeDepth } from './transition'

describe('routeDepth', () => {
  it('首页为 0，工具页与设置页为 1', () => {
    expect(routeDepth('/')).toBe(0)
    expect(routeDepth('')).toBe(0)
    expect(routeDepth('/tool/ruler')).toBe(1)
    expect(routeDepth('/settings')).toBe(1)
  })
})

describe('pageTransition', () => {
  it('首页 → 工具页、设置页：推入', () => {
    expect(pageTransition('/tool/ruler', '/')).toBe('push')
    expect(pageTransition('/settings', '/')).toBe('push')
  })
  it('工具页、设置页 → 首页：弹出（含 replace 回首页的兜底）', () => {
    expect(pageTransition('/', '/tool/ruler')).toBe('pop')
    expect(pageTransition('/', '/settings')).toBe('pop')
  })
  it('同层切换（深链从一个工具跳到另一个）和首页到首页：按推入', () => {
    expect(pageTransition('/tool/a', '/tool/b')).toBe('push')
    expect(pageTransition('/', '/')).toBe('push')
  })
})

describe('isCachedRoute', () => {
  it('只有首页被缓存', () => {
    expect(isCachedRoute('home')).toBe(true)
    expect(isCachedRoute('tool')).toBe(false)
    expect(isCachedRoute('settings')).toBe(false)
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
