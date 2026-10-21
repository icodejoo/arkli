import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]
/** useFloatPause 的参数体 */
const HOOK = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)|useFloatPause\(\{([^\n]*)\}\)/)?.[0] ?? ''

describe('notify-self 浮窗接入守卫', () => {
  it('调用 useFloatPause：pause 停轮询，resume 先刷新再重开轮询', () => {
    expect(HOOK).toMatch(/pause: stopLoop/)
    expect(HOOK).toMatch(/resume:[\s\S]*now\.value = Date\.now\(\)[\s\S]*refresh\(\)[\s\S]*startLoop\(\)/)
  })
  it('暂停不取消系统闹钟', () => {
    expect(HOOK).not.toMatch(/cancelAlarm/)
  })
  it('startLoop 先 stopLoop，不叠加定时器', () => {
    expect(SRC).toMatch(/function startLoop\(\)[^]*?stopLoop\(\)/)
  })
})
