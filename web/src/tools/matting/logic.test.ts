import { describe, expect, it } from 'vitest'
import { BG_OPTIONS, MATTING_MODES, MODE_HINTS, MODE_LABELS, PROVIDER_OF_MODE, bgColorOf, modeOfProvider, outputName, resultUrl, summaryOf } from './logic'

describe('模式与提供者', () => {
  it('两个模式各对应一个提供者，互不相同', () => {
    expect(MATTING_MODES).toEqual(['portrait', 'general'])
    expect(PROVIDER_OF_MODE).toEqual({ portrait: 'local-matting-portrait', general: 'local-matting-general' })
    expect(new Set(Object.values(PROVIDER_OF_MODE)).size).toBe(2)
    for (const m of MATTING_MODES) {
      expect(MODE_LABELS[m]).toBeTruthy()
      expect(MODE_HINTS[m]).toBeTruthy()
    }
  })
  it('提供者 id 反查模式：认识的反查，不认识与空回落人像', () => {
    expect(modeOfProvider('local-matting-general')).toBe('general')
    expect(modeOfProvider('local-matting-portrait')).toBe('portrait')
    expect(modeOfProvider('local-ocr')).toBe('portrait')
    expect(modeOfProvider(undefined)).toBe('portrait')
    expect(modeOfProvider(null)).toBe('portrait')
  })
})

describe('背景', () => {
  it('透明没有颜色，纯白与自定义有', () => {
    expect(bgColorOf('transparent', '#123456')).toBeNull()
    expect(bgColorOf('white', '#123456')).toBe('#ffffff')
    expect(bgColorOf('custom', '#123456')).toBe('#123456')
  })
  it('选项顺序：透明、纯白、自定义', () => {
    expect(BG_OPTIONS.map((o) => o.kind)).toEqual(['transparent', 'white', 'custom'])
  })
})

describe('文件名与地址', () => {
  it('导出名：去扩展名、特殊字符换下划线、空名兜底', () => {
    expect(outputName('IMG_001.jpg', 'png')).toBe('IMG_001_cutout.png')
    expect(outputName('我的 照片.jpeg', 'jpg')).toBe('我的_照片_cutout.jpg')
    expect(outputName('a/b:c?.png', 'png')).toBe('a_b_c_cutout.png')
    expect(outputName('', 'png')).toBe('image_cutout.png')
    expect(outputName(undefined, 'jpg')).toBe('image_cutout.jpg')
    expect(outputName('.png', 'png')).toBe('image_cutout.png')
  })
  it('缓存路径转页面地址', () => {
    expect(resultUrl('cache/out/a.png')).toBe('/files/cache/out/a.png')
  })
  it('摘要文案含尺寸、总耗时与推理耗时', () => {
    expect(summaryOf({ width: 1024, height: 768, elapsedMs: 812, inferMs: 640 })).toBe('1024×768 · 用时 812 ms（推理 640 ms）')
  })
})
