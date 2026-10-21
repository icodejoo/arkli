import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

describe('指南针 浮窗接入守卫', () => {
  it('接了 useFloatPause，且 pause 与 resume 都有实现', () => {
    expect(SRC).toContain("import { useFloatPause } from '@/shared/useFloatPause'")
    expect(SRC).toMatch(/useFloatPause\(\{[\s\S]*pause:[\s\S]*resume:/)
  })
  it('暂停取消订阅并释放常亮，恢复重订并重新常亮；卸载仍做最终清理', () => {
    expect(SRC).toMatch(/pause: \(\) => \{\s*session\.pause\(\)[\s\S]*awake\.release/)
    expect(SRC).toMatch(/resume: \(\) => \{\s*session\.resume\(\)[\s\S]*awake\.acquire/)
    expect(SRC).toContain('session.dispose()')
  })
})
