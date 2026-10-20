import { describe, expect, it } from 'vitest'

/** 所有 vue 源码的原文，路径为 key */
const sources = import.meta.glob('/src/**/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** 禁用的表单标签：单选组、单选、多选组、多选（后三者用前缀匹配，van-radio-group 也会命中 van-radio） */
const FORBIDDEN_FORM_TAGS = /<van-(radio|checkbox)/

describe('项目规则：Vant 用法', () => {
  it('van-notice-bar 的换行属性是 wrapable，不是 wrap-able（写错了不换行，长文案被省略）', () => {
    const bad = Object.entries(sources)
      .filter(([, src]) => /wrap-able/.test(src))
      .map(([p]) => p)
    expect(bad).toEqual([])
  })

  it('不得使用 van-radio / van-checkbox：单选用 cell-picker，布尔开关用 van-switch', () => {
    const bad = Object.entries(sources)
      .filter(([, src]) => FORBIDDEN_FORM_TAGS.test(src))
      .map(([p]) => p)
    expect(bad, `这些文件用了 van-radio / van-checkbox：\n${bad.join('\n')}`).toEqual([])
  })

  it('扫描确实覆盖到了页面源码（防止 glob 失效导致上面的断言空转）', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50)
  })
})
