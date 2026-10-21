import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

describe('设备信息 浮窗接入守卫', () => {
  it('接了 useFloatPause，且 pause 与 resume 都有实现', () => {
    expect(SRC).toContain("import { useFloatPause } from '@/shared/useFloatPause'")
    expect(SRC).toMatch(/useFloatPause\(\{[\s\S]*pause:[\s\S]*resume:/)
  })
  it('自动刷新定时器走可暂停定时器，恢复时立刻刷新一次', () => {
    expect(SRC).toContain('createPausableInterval')
    expect(SRC).toContain('timer.pause()')
    expect(SRC).toMatch(/timer\.resume\(\)\) void refreshLive\(\)/)
  })
})
