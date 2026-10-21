import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]
/** useFloatPause 的参数体 */
const HOOK = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)/)?.[0] ?? ''

describe('roll-call 浮窗接入守卫', () => {
  it('pause 提前结算动画，resume 无需恢复', () => {
    expect(HOOK).toMatch(/pause: \(\) => void anim\.settleNow\(\)/)
    expect(HOOK).toMatch(/resume: \(\) => \{\}/)
  })
  it('动画走可提前结算的 createSettleTimer，卸载时清掉', () => {
    expect(SRC).toContain('createSettleTimer()')
    expect(SRC).toMatch(/anim\.clear/)
  })
  it('提前结算不播反馈 / 不弹提示（early 为 true 时跳过）', () => {
    expect(SRC).toMatch(/early/)
  })
})
