import { describe, expect, it } from 'vitest'
import { allowsAuto, AUTO_LANG, buildColumns, coercePair, isAuto, isLang, isSourceLang, LANGS, pickLang, srcLabel, swapLangs } from './languages'

/** 模拟 L1 支持的集合 */
const SUP = ['zh-CN', 'en', 'fr', 'es', 'ru', 'ar']

describe('auto（自动检测）', () => {
  it('AUTO_LANG 不在 LANGS 里；isLang 不认 auto，isSourceLang 认', () => {
    expect(AUTO_LANG).toEqual({ code: 'auto', name: '自动检测' })
    expect(LANGS.some((l) => l.code === 'auto')).toBe(false)
    expect(isAuto('auto')).toBe(true)
    expect(isAuto('en')).toBe(false)
    expect(isLang('auto')).toBe(false)
    expect(isSourceLang('auto')).toBe(true)
    expect(isSourceLang('en')).toBe(true)
    expect(isSourceLang('xx')).toBe(false)
  })
  it('allowsAuto 读 sourceAuto', () => {
    expect(allowsAuto({ sourceAuto: true })).toBe(true)
    expect(allowsAuto({})).toBe(false)
    expect(allowsAuto(undefined)).toBe(false)
  })
  it('coercePair：模型支持 auto 时源 auto 合法，只校验目标', () => {
    expect(coercePair({ src: 'auto', tgt: 'fr' }, SUP, true)).toEqual({ src: 'auto', tgt: 'fr' })
    expect(coercePair({ src: 'auto', tgt: 'de' }, SUP, true)).toEqual({ src: 'auto', tgt: 'zh-CN' })
  })
  it('coercePair：模型不支持 auto 时换成与目标不同的第一个支持语言', () => {
    expect(coercePair({ src: 'auto', tgt: 'zh-CN' }, SUP)).toEqual({ src: 'en', tgt: 'zh-CN' })
    expect(coercePair({ src: 'auto', tgt: 'en' }, SUP)).toEqual({ src: 'zh-CN', tgt: 'en' })
    expect(coercePair({ src: 'auto', tgt: 'de' }, SUP)).toEqual({ src: 'zh-CN', tgt: 'en' })
  })
  it('pickLang：auto 只能选在源侧且需模型支持', () => {
    const p = { src: 'en', tgt: 'zh-CN' }
    expect(pickLang(p, 'src', 'auto', SUP, true)).toEqual({ src: 'auto', tgt: 'zh-CN' })
    expect(pickLang(p, 'src', 'auto', SUP, false)).toBe(p)
    expect(pickLang(p, 'tgt', 'auto', SUP, true)).toBe(p)
  })
  it('pickLang：源为 auto 时选目标不触发互斥换语言', () => {
    expect(pickLang({ src: 'auto', tgt: 'zh-CN' }, 'tgt', 'en', SUP, true)).toEqual({ src: 'auto', tgt: 'en' })
  })
  it('pickLang：从 auto 切到具体语言，与目标相同则按互斥规则处理', () => {
    expect(pickLang({ src: 'auto', tgt: 'zh-CN' }, 'src', 'zh-CN', SUP, true)).toEqual({ src: 'zh-CN', tgt: 'en' })
    expect(pickLang({ src: 'auto', tgt: 'zh-CN' }, 'src', 'fr', SUP, true)).toEqual({ src: 'fr', tgt: 'zh-CN' })
  })
  it('buildColumns：auto 在支持集合里时排最前', () => {
    const cols = buildColumns(['auto', ...SUP], [AUTO_LANG, ...LANGS])
    expect(cols[0]).toEqual({ text: '自动检测', value: 'auto', disabled: false })
  })
  it('srcLabel：未识别 / 单个 / 两个 / 超过两个', () => {
    expect(srcLabel('en')).toBe('English')
    expect(srcLabel('auto')).toBe('自动检测')
    expect(srcLabel('auto', [])).toBe('自动检测')
    expect(srcLabel('auto', ['en'])).toBe('自动检测（English）')
    expect(srcLabel('auto', ['en', 'fr'])).toBe('自动检测（English、Français）')
    expect(srcLabel('auto', ['en', 'fr', 'es'])).toBe('自动检测（English、Français等）')
  })
  it('swapLangs：源非 auto 就是普通交换', () => {
    expect(swapLangs({ src: 'en', tgt: 'fr' }, ['en'], SUP)).toEqual({ src: 'fr', tgt: 'en' })
  })
  it('swapLangs：源 auto 优先用识别出的第一个语言', () => {
    expect(swapLangs({ src: 'auto', tgt: 'zh-CN' }, ['fr', 'en'], SUP)).toEqual({ src: 'zh-CN', tgt: 'fr' })
  })
  it('swapLangs：没识别、不被支持或与新源相同时回落，优先 en', () => {
    expect(swapLangs({ src: 'auto', tgt: 'zh-CN' }, [], SUP)).toEqual({ src: 'zh-CN', tgt: 'en' })
    expect(swapLangs({ src: 'auto', tgt: 'zh-CN' }, ['de'], SUP)).toEqual({ src: 'zh-CN', tgt: 'en' })
    expect(swapLangs({ src: 'auto', tgt: 'en' }, ['en'], SUP)).toEqual({ src: 'en', tgt: 'zh-CN' })
  })
})
