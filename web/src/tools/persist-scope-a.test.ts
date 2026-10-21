import { describe, expect, it } from 'vitest'

/** 各工具页源码：目录名 -> index.vue 原文 */
const SRC = import.meta.glob('./*/index.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** 本批工具要持久化的缓存键（工具目录名 -> 键列表） */
const PERSISTED: Record<string, string[]> = {
  'ai-writer': ['mode', 'nameKind'],
  'app-manager': ['sortKey', 'showSystem'],
  'barcode-gen': ['kind', 'scale', 'barHeight', 'showText'],
  'base-convert': ['fromBase', 'bits'],
  base64: ['mode', 'urlSafe', 'padding'],
  'bead-pattern': ['gridChoice', 'customN', 'paletteId'],
  bmi: ['sex', 'factor'],
  'char-lookup': ['tone'],
  'clock-screen': ['style', 'showSeconds', 'showDate', 'hour24', 'showLunar'],
  'coin-flip': ['batch'],
  'color-convert': ['tab', 'scheme'],
  couplet: ['mode', 'poolId', 'bannerChoice', 'category', 'quizSource', 'quizLen'],
}

describe('选项类控件持久化守卫', () => {
  for (const [tool, keys] of Object.entries(PERSISTED)) {
    it(`${tool}: 用持久 ref 记住 ${keys.join('、')}，且带校验`, () => {
      const src = SRC[`./${tool}/index.vue`]
      expect(src, `${tool}/index.vue 不存在`).toBeTruthy()
      for (const k of keys) {
        const m = src.match(new RegExp(String.raw`usePersistedRef(?:<[^\n]*?>)?\(\s*\w+,\s*'${k}',[^\n]*`))
        expect(m, `${tool} 缺少 '${k}' 的持久化`).toBeTruthy()
      }
    })
  }

  it('范围内工具页不再直接用 localStorage（coin-flip 与 dice 共用的震动/音效开关除外）', () => {
    for (const tool of [...Object.keys(PERSISTED), 'countdown'].filter((t) => t !== 'coin-flip')) {
      // 先剔除文档注释，注释里提到旧键不算直接使用
      expect(SRC[`./${tool}/index.vue`].replace(/\/\*\*.*?\*\//g, ''), tool).not.toMatch(/\blocalStorage\b/)
    }
  })
})
