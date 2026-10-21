import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]
/** useFloatPause 的参数体 */
const HOOK = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)/)?.[0] ?? ''

describe('meme-maker 浮窗接入守卫', () => {
  it('pause 取消排队重绘帧并放掉拖动；resume 重画', () => {
    expect(HOOK).toMatch(/pause:[\s\S]*cancelAnimationFrame\(redrawRaf\)[\s\S]*redrawRaf = 0[\s\S]*drag = null/)
    expect(HOOK).toMatch(/resume: redraw/)
  })
  it('保存全部（saving）单独汇报 busy，生成中由 main-loading 自动汇报', () => {
    expect(SRC).toContain('useFloatBusy(() => saving.value)')
    expect(SRC).toContain(':main-loading="busy"')
  })
})
