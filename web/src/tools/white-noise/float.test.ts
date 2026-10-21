import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]
/** useFloatPause 的参数体 */
const HOOK = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)/)?.[1] ?? ''

describe('white-noise 浮窗接入守卫', () => {
  it('调用 useFloatPause', () => {
    expect(HOOK).not.toBe('')
  })
  it('pause：只在播放中生效，冻结定时剩余、停倒计时刷新、suspend 音频', () => {
    expect(HOOK).toMatch(/pause:[\s\S]*playing\.value[\s\S]*remainingMs\([\s\S]*clearInterval\(ticker\)[\s\S]*ctx\?\.suspend\(\)/)
  })
  it('resume：只在浮起前在播放时续播，用 resumeEndAt 重算关闭时刻并重开刷新', () => {
    expect(HOOK).toMatch(/resume:[\s\S]*resumeAfterFloat[\s\S]*ctx\?\.resume\(\)[\s\S]*resumeEndAt\([\s\S]*startTicker\(\)/)
  })
})
