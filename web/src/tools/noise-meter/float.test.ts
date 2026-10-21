import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

describe('噪音测量 浮窗接入守卫', () => {
  it('接了 useFloatPause，且 pause 与 resume 都有实现', () => {
    expect(SRC).toContain("import { useFloatPause } from '@/shared/useFloatPause'")
    expect(SRC).toMatch(/useFloatPause\(\{[\s\S]*pause:[\s\S]*resume:/)
  })
  it('用暂停闸：暂停停采样、取消 rAF 并 stopNoise，恢复重订并 startNoise；统计量不在暂停里清', () => {
    expect(SRC).toContain('createPauseGate')
    expect(SRC).toMatch(/suspend: async \(\) => \{[\s\S]*cancelAnimationFrame[\s\S]*await stopNoise\(\)/)
    expect(SRC).toMatch(/restore: async \(\) => \{[\s\S]*onNoiseSample[\s\S]*await startNoise/)
    expect(SRC).not.toMatch(/suspend: async \(\) => \{[\s\S]{0,300}(tracker\.reset|ring\.clear)/)
  })
  it('授权弹窗期间被暂停时不在后台占麦克风', () => {
    expect(SRC).toContain('gate.suspended')
  })
})
