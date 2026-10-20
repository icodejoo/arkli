import { describe, expect, it } from 'vitest'

/** 页面源码 */
const SRC = Object.values(import.meta.glob('./index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0]

describe('logo 页源码守卫', () => {
  it('不碰模型管理：只读状态，不出现 ensure/cancel/remove/verify 与下载进度', () => {
    expect(SRC).not.toMatch(/native\.model|ensureModel|removeModel|verifyModel|cancelDownload|downloadProgress/)
  })
  it('颜色用 ColorPicker，不写原生 input[type=color]', () => {
    expect(SRC).toContain('<color-picker')
    expect(SRC).not.toMatch(/type=["']color["']/)
  })
  it('模型选择器用默认插槽，不传自定义触发器', () => {
    expect(SRC).toMatch(/<model-picker [^>]*\/>/)
  })
  it('不用系统文件选择器与相机', () => {
    expect(SRC).not.toMatch(/<input[^>]*type=["']file["']/)
  })
  it('文案说智能排版，不说 AI 画图', () => {
    expect(SRC).toContain('智能排版')
    expect(SRC).not.toMatch(/AI ?画图|AI ?绘图|AI ?生成图/)
  })
})
