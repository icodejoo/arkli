import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

describe('量角器 浮窗接入守卫', () => {
  it('接了 useFloatPause，且 pause 与 resume 都有实现', () => {
    expect(SRC).toContain("import { useFloatPause } from '@/shared/useFloatPause'")
    expect(SRC).toMatch(/useFloatPause\(\{[\s\S]*pause:[\s\S]*resume:/)
  })
  it('走可暂停监听；暂停不清锁定读数（只有 end 才清）', () => {
    expect(SRC).toContain('createPausableListener')
    expect(SRC).toContain('listener.pause()')
    expect(SRC).toContain('listener.resume()')
    expect(SRC).not.toMatch(/pause:[^\n]*(end\(|lockedTilt)/)
  })
})
