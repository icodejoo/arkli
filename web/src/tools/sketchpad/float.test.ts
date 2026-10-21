import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]
/** useFloatPause 的参数体 */
const HOOK = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)/)?.[0] ?? ''

describe('sketchpad 浮窗接入守卫', () => {
  it('pause：收笔入栈、取消排队帧、同步画完、停尺寸监听；画布内容不清', () => {
    expect(HOOK).toMatch(/pause:[\s\S]*commitCurrent\(\)[\s\S]*cancelScheduled\(\)[\s\S]*redraw\(\)[\s\S]*unwatchSize\(\)/)
    expect(HOOK).not.toMatch(/clearStack|doClear/)
  })
  it('resume：重新监听并校准画布尺寸', () => {
    expect(HOOK).toMatch(/resume:[\s\S]*watchSize\(\)[\s\S]*resize\(\)/)
  })
  it('导出中靠 main-loading 自动汇报 busy，不重复调用 useFloatBusy', () => {
    expect(SRC).toContain(':main-loading="saving"')
    expect(SRC).not.toContain('useFloatBusy')
  })
})
