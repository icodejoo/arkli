import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]
/** useFloatPause 的参数体 */
const HOOK = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)|useFloatPause\(\{([^\n]*)\}\)/)?.[0] ?? ''

describe('morse 浮窗接入守卫', () => {
  it('pause 停止播放；不用 useFloatBusy（不拦截浮窗）', () => {
    expect(HOOK).toMatch(/pause: stop/)
    expect(SRC).not.toContain('useFloatBusy')
  })
  it('resume 不自动续播', () => {
    expect(HOOK).toMatch(/resume: \(\) => \{\}/)
  })
})
