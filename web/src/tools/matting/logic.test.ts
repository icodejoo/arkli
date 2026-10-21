import { describe, expect, it } from 'vitest'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import {
  BG_OPTIONS,
  DEFAULT_REFINE,
  REFINE_OPTIONS,
  REFINE_STORAGE_KEY,
  normalizeRefine,
  shouldRerunOnRefine,
  MATTING_MODES, MODE_HINTS, MODE_LABELS, PROVIDER_OF_MODE, bgColorOf, modeOfProvider, outputName, resultUrl, summaryOf,
} from './logic'
import indexSource from './index.vue?raw'

describe('模式与提供者', () => {
  it('四个模式各对应一个提供者，互不相同', () => {
    expect(MATTING_MODES).toEqual(['portrait', 'general', 'ppmatting', 'birefnet'])
    expect(PROVIDER_OF_MODE).toEqual({
      portrait: 'local-matting-portrait',
      general: 'local-matting-general',
      ppmatting: 'local-matting-ppmatting',
      birefnet: 'local-matting-birefnet',
    })
    expect(new Set(Object.values(PROVIDER_OF_MODE)).size).toBe(4)
    for (const m of MATTING_MODES) {
      expect(MODE_LABELS[m]).toBeTruthy()
      expect(MODE_HINTS[m]).toBeTruthy()
    }
    expect(MODE_LABELS.ppmatting).toContain('实验')
    // BiRefNet 已转正为“通用高精”，说明里必须提醒不建议用于人像
    expect(MODE_LABELS.birefnet).toBe('通用高精')
    expect(MODE_HINTS.birefnet).toContain('不建议用于人像')
  })
  it('提供者 id 反查模式：认识的反查，不认识与空回落人像', () => {
    expect(modeOfProvider('local-matting-general')).toBe('general')
    expect(modeOfProvider('local-matting-portrait')).toBe('portrait')
    expect(modeOfProvider('local-matting-ppmatting')).toBe('ppmatting')
    expect(modeOfProvider('local-matting-birefnet')).toBe('birefnet')
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

describe('边缘细化档位', () => {
  it('四档按 关/轻/标准/强 排列，默认强', () => {
    expect(REFINE_OPTIONS.map((o) => o.label)).toEqual(['关', '轻', '标准', '强'])
    expect(REFINE_OPTIONS.map((o) => o.value)).toEqual(['off', 'light', 'standard', 'strong'])
    expect(DEFAULT_REFINE).toBe('strong')
  })
  it('normalizeRefine：合法原样，其余回落默认', () => {
    expect(normalizeRefine('light')).toBe('light')
    expect(normalizeRefine('x')).toBe('strong')
    expect(normalizeRefine(null)).toBe('strong')
    expect(normalizeRefine(3)).toBe('strong')
  })
  it('持久化：旧键迁入、非法缓存回落默认、读回', () => {
    const mem = new Map<string, string>([[REFINE_STORAGE_KEY, 'light']])
    const backend = {
      get length() {
        return mem.size
      },
      key: (i: number) => [...mem.keys()][i] ?? null,
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    }
    const st = createToolStorage('matting', backend)
    st.adoptLegacy(REFINE_STORAGE_KEY, 'refine', normalizeRefine)
    expect(mem.has(REFINE_STORAGE_KEY)).toBe(false)
    expect(usePersistedRef(st, 'refine', DEFAULT_REFINE, (v) => normalizeRefine(v) === v).value).toBe('light')
    st.set('refine', 'bogus')
    expect(usePersistedRef(st, 'refine', DEFAULT_REFINE, (v) => normalizeRefine(v) === v).value).toBe('strong')
  })
  it('切换档位：有结果且档位变了才重跑；没出图或没变只记住', () => {
    expect(shouldRerunOnRefine('strong', 'light', true)).toBe(true)
    expect(shouldRerunOnRefine('strong', 'light', false)).toBe(false)
    expect(shouldRerunOnRefine('strong', 'strong', true)).toBe(false)
  })
})

describe('抠图页接线（无 DOM 环境，按源码守卫）', () => {
  it('渲染四档分段控件与说明，切换走 onRefine，抠图调用带上 refine', () => {
    expect(indexSource).toContain('REFINE_OPTIONS')
    expect(indexSource).toContain('REFINE_HINT')
    expect(indexSource).toContain('边缘细化')
    expect(indexSource).toContain('@change="onRefine"')
    expect(indexSource).toMatch(/aiMatting\(path, mode\.value, ctl\.signal, undefined, refine\.value\)/)
    expect(indexSource).toContain('shouldRerunOnRefine(')
  })
})
