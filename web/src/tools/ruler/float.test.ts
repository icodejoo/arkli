import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]
/** useFloatPause 的参数体 */
const HOOK = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)/)?.[0] ?? ''

describe('ruler 浮窗接入守卫', () => {
  it('pause 解绑监听；resume 重新绑定并重画', () => {
    expect(HOOK).toMatch(/pause: unbindListeners/)
    expect(HOOK).toMatch(/resume:[\s\S]*bindListeners\(\)[\s\S]*redraw\(\)/)
  })
  it('bindListeners 先解绑再绑（不重复），挂载 / 卸载走同一对', () => {
    expect(SRC).toMatch(/function bindListeners\(\)[^]*?unbindListeners\(\)/)
    expect(SRC).toContain('onUnmounted(unbindListeners)')
  })
})
