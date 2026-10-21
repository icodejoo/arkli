import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]
/** useFloatPause 的参数体 */
const HOOK = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)/)?.[0] ?? ''

describe('roll-call 浮窗接入守卫', () => {
  it('pause 提前结算并暂停慢转，resume 恢复慢转', () => {
    expect(HOOK).toMatch(/pause: \(\) => void pauseStage\(\)/)
    expect(HOOK).toMatch(/resume: \(\) => \{[\s\S]*?stageInstance\.setPaused\(false\)/)
    expect(SRC).toMatch(/onDeactivated\(\(\) => \{\s*foreground = false/)
    expect(SRC).toMatch(/function pauseStage[\s\S]*?settleNow\(\)[\s\S]*?setPaused\(true\)/)
  })
  it('自动模式动画回调按非提前结算，不能调 anim.settleNow（否则跳过结算动画）', () => {
    expect(SRC).not.toMatch(/\(\) => \{\s*anim\.settleNow\(\)/)
    expect(SRC).toMatch(/anim\.clear\(\)\s*finish\(false\)/)
  })
  it('动画走可提前结算的 createSettleTimer，卸载时清掉', () => {
    expect(SRC).toContain('createSettleTimer()')
    expect(SRC).toMatch(/anim\.clear/)
  })
  it('不再有空闲停转唤醒：页面不调 wake', () => {
    expect(SRC).not.toMatch(/\.wake\(/)
  })
  it('提前结算不播反馈 / 不弹提示（early 为 true 时跳过）', () => {
    expect(SRC).toMatch(/early/)
  })
})
