import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

describe('语音转文字 浮窗接入守卫', () => {
  it('接了 useFloatPause，且 pause 与 resume 都有实现', () => {
    expect(SRC).toContain("import { useFloatPause } from '@/shared/useFloatPause'")
    expect(SRC).toMatch(/useFloatPause\(\{[\s\S]*pause:[\s\S]*resume:/)
  })
  it('录音中收尾、启动中等启动完收尾，resume 不自动重录', () => {
    expect(SRC).toContain('sttPausePlan(')
    expect(SRC).toContain('stopAfterStart')
    expect(SRC).toMatch(/resume: \(\) => undefined/)
  })
  it('录音中的 busy 由主按钮 main-loading 自动汇报', () => {
    expect(SRC).toContain(':main-loading="listening"')
  })
})
