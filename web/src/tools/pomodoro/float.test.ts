import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

describe('pomodoro 浮窗接入守卫', () => {
  it('调用 useFloatPause，pause 停刷新并放常亮，resume 重开刷新并按状态重申请常亮', () => {
    const m = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)/)
    expect(m).not.toBeNull()
    const body = m![1]
    expect(body).toMatch(/pause:[\s\S]*stopLoop\(\)[\s\S]*applyAwake\(false\)/)
    expect(body).toMatch(/resume:[\s\S]*startLoop\(\)[\s\S]*applyAwake\(wantsAwake\(/)
  })
  it('暂停不取消原生闹钟（浮起期间到点仍提醒）', () => {
    const m = SRC.match(/useFloatPause\(\{([\s\S]*?)\n\}\)/)
    expect(m![1]).not.toMatch(/disarmAlarm|cancelAlarm/)
  })
  it('startLoop 先 stopLoop，重复调用不叠加定时器；挂载与卸载都走这一对', () => {
    expect(SRC).toMatch(/function startLoop\(\)[^]*?stopLoop\(\)/)
    expect(SRC).toContain('onMounted(startLoop)')
    expect(SRC).toMatch(/onBeforeUnmount\(\(\) => \{\s*stopLoop\(\)/)
  })
})
