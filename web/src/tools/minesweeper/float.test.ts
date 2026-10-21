import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]
/** useFloatPause 的参数体 */
const HOOK = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)|useFloatPause\(\{([^\n]*)\}\)/)?.[0] ?? ''

describe('minesweeper 浮窗接入守卫', () => {
  it('pause 停表；resume 只在对局进行中才接着走字', () => {
    expect(HOOK).toMatch(/pause: stopTimer/)
    expect(HOOK).toMatch(/resume:[\s\S]*isClockTicking\(game\.value\.status\)[\s\S]*startTimer\(\)/)
  })
  it('startTimer 防重复开表；状态监听也走 startTimer', () => {
    expect(SRC).toMatch(/function startTimer\(\)[^]*?if \(!timer\)/)
    expect(SRC).toMatch(/if \(isClockTicking\(s\)\) startTimer\(\)/)
  })
})
