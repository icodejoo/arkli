import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

describe('拼豆图纸 浮窗接入守卫', () => {
  it('没有常驻资源：相机只走原生拍照页，无 getUserMedia/video/计时器；生成/解析中由主按钮 loading 自动汇报 busy', () => {
    expect(SRC).not.toMatch(/getUserMedia|<video|setInterval|requestAnimationFrame/)
    expect(SRC).toMatch(/:main-loading="(busy|loading)"/)
    expect(SRC).not.toContain('useFloatPause(')
  })
})
