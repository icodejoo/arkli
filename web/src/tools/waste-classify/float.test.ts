import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

describe('垃圾识别 浮窗接入守卫', () => {
  it('汇报 busy（useFloatBusy）', () => {
    expect(SRC).toContain("import { useFloatBusy } from '@/shared/useFloatPause'")
    expect(SRC).toContain('useFloatBusy(() => busy.value)')
  })
  it('没有常驻相机预览：只走原生拍照页，不接 useFloatPause', () => {
    expect(SRC).not.toMatch(/getUserMedia|<video/)
    expect(SRC).not.toContain('useFloatPause(')
  })
})
