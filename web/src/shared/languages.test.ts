import { describe, expect, it } from 'vitest'
import { buildColumns, coercePair, isLang, isSupported, LANGS, langName, pickLang, supportedOf } from './languages'

/** NLLB 支持的 6 种 */
const SIX = ['zh-CN', 'en', 'fr', 'es', 'ru', 'ar']

describe('语言目录', () => {
  it('码不重复、每项有名称、含关键语言、zh-CN/en 在前', () => {
    expect(new Set(LANGS.map((l) => l.code)).size).toBe(LANGS.length)
    expect(LANGS.every((l) => l.name.length > 0)).toBe(true)
    expect(LANGS.length).toBeGreaterThanOrEqual(30)
    for (const c of ['ja', 'ko', 'de', 'pt', 'hi', 'zh-TW']) expect(isLang(c)).toBe(true)
    expect(LANGS[0].code).toBe('zh-CN')
    expect(LANGS[2].code).toBe('en')
  })
  it('isLang / langName', () => {
    expect(isLang('fr')).toBe(true)
    expect(isLang('xx')).toBe(false)
    expect(langName('ar')).toBe('العربية')
    expect(langName('xx')).toBe('xx')
  })
})

describe('supportedOf / isSupported', () => {
  it('缺省与 all 为全集', () => {
    expect(supportedOf()).toHaveLength(LANGS.length)
    expect(supportedOf({ languages: 'all' })).toHaveLength(LANGS.length)
    expect(supportedOf({})).toHaveLength(LANGS.length)
  })
  it('数组按目录顺序过滤，忽略目录外的码', () => {
    expect(supportedOf({ languages: ['ar', 'en', 'zz'] })).toEqual(['en', 'ar'])
    expect(isSupported({ languages: SIX }, 'ja')).toBe(false)
    expect(isSupported({ languages: SIX }, 'fr')).toBe(true)
  })
})

describe('coercePair', () => {
  it('都支持：原样', () => {
    const p = { src: 'en', tgt: 'fr' }
    expect(coercePair(p, SIX)).toBe(p)
  })
  it('一侧不支持：另一侧不变，换成第一个不同的', () => {
    expect(coercePair({ src: 'de', tgt: 'zh-CN' }, SIX)).toEqual({ src: 'en', tgt: 'zh-CN' })
    expect(coercePair({ src: 'de', tgt: 'en' }, SIX)).toEqual({ src: 'zh-CN', tgt: 'en' })
    expect(coercePair({ src: 'en', tgt: 'ja' }, SIX)).toEqual({ src: 'en', tgt: 'zh-CN' })
  })
  it('两侧都不支持：取前两项', () => {
    expect(coercePair({ src: 'de', tgt: 'ja' }, SIX)).toEqual({ src: 'zh-CN', tgt: 'en' })
  })
  it('支持集合少于 2 种：原样返回', () => {
    const p = { src: 'de', tgt: 'ja' }
    expect(coercePair(p, ['en'])).toBe(p)
    expect(coercePair(p, [])).toBe(p)
  })
})

describe('pickLang', () => {
  it('选不冲突的语言只改自己这一侧', () => {
    expect(pickLang({ src: 'en', tgt: 'zh-CN' }, 'src', 'fr')).toEqual({ src: 'fr', tgt: 'zh-CN' })
    expect(pickLang({ src: 'en', tgt: 'zh-CN' }, 'tgt', 'es')).toEqual({ src: 'en', tgt: 'es' })
  })
  it('选成和另一侧相同：另一侧换成自己原来的', () => {
    expect(pickLang({ src: 'en', tgt: 'zh-CN' }, 'src', 'zh-CN')).toEqual({ src: 'zh-CN', tgt: 'en' })
    expect(pickLang({ src: 'en', tgt: 'zh-CN' }, 'tgt', 'en')).toEqual({ src: 'zh-CN', tgt: 'en' })
  })
  it('传 supported：不支持的被拒绝，支持的正常', () => {
    const p = { src: 'en', tgt: 'zh-CN' }
    expect(pickLang(p, 'src', 'ja', SIX)).toBe(p)
    expect(pickLang(p, 'tgt', 'fr', SIX)).toEqual({ src: 'en', tgt: 'fr' })
  })
  it('换过去的另一侧也必须被支持', () => {
    expect(pickLang({ src: 'de', tgt: 'zh-CN' }, 'src', 'zh-CN', SIX)).toEqual({ src: 'zh-CN', tgt: 'en' })
  })
})

describe('buildColumns', () => {
  it('支持的在前不置灰，不支持的在后置灰，各自保持目录顺序', () => {
    const cols = buildColumns(SIX)
    expect(cols).toHaveLength(LANGS.length)
    expect(cols.slice(0, 6).map((c) => c.value)).toEqual(['zh-CN', 'en', 'fr', 'es', 'ru', 'ar'])
    expect(cols.slice(0, 6).every((c) => !c.disabled)).toBe(true)
    expect(cols.slice(6).every((c) => c.disabled)).toBe(true)
    expect(cols[6].value).toBe('zh-TW')
  })
})
