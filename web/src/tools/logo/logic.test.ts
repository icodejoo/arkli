import { describe, expect, it } from 'vitest'
import { ICON_DATA } from './assets/iconData'
import { NAME_MAX, ICON_SEARCH_LIMIT, canGenerate, clamp, clampFontScale, clampSpacing, outputName, paramsFromPlan, searchIcons, syncInput } from './logic'
import { FONT_SCALE_MAX, FONT_SCALE_MIN, SPACING_MAX, SPACING_MIN } from './types'

describe('canGenerate', () => {
  it('空白不行，有字可以', () => {
    expect(canGenerate('')).toBe(false)
    expect(canGenerate('  \n')).toBe(false)
    expect(canGenerate(' A ')).toBe(true)
  })
})

describe('clamp', () => {
  it('夹紧与非数字兜底', () => {
    expect(clamp(5, 0, 1, 0.5)).toBe(1)
    expect(clamp(-5, 0, 1, 0.5)).toBe(0)
    expect(clamp(NaN, 0, 1, 0.5)).toBe(0.5)
    expect(clampFontScale(9)).toBe(FONT_SCALE_MAX)
    expect(clampFontScale(0)).toBe(FONT_SCALE_MIN)
    expect(clampSpacing(9)).toBe(SPACING_MAX)
    expect(clampSpacing(-9)).toBe(SPACING_MIN)
  })
})

describe('paramsFromPlan / syncInput', () => {
  const plan = { template: 'stack', palette: 'tech-blue', icon: 'coffee', font: 'sans-bold' } as const
  it('带上方案与去空白后的输入，其余取默认', () => {
    const p = paramsFromPlan(plan, { name: ' 山屿 ', slogan: ' hi ', desc: '' })
    expect(p).toMatchObject({ template: 'stack', palette: 'tech-blue', icon: 'coffee', name: '山屿', slogan: 'hi', fontScale: 1, invert: false })
  })
  it('超长品牌名被截断', () => {
    expect(paramsFromPlan(plan, { name: 'a'.repeat(99), slogan: '', desc: '' }).name.length).toBe(NAME_MAX)
  })
  it('syncInput 只改文字', () => {
    const p = paramsFromPlan(plan, { name: 'A', slogan: '', desc: '' })
    expect(syncInput({ ...p, invert: true }, { name: 'B', slogan: 'c', desc: '' })).toMatchObject({ name: 'B', slogan: 'c', invert: true, template: 'stack' })
  })
})

describe('searchIcons', () => {
  it('中文关键词命中', () => {
    expect(searchIcons('咖啡')).toContain('coffee')
  })
  it('英文名命中', () => {
    expect(searchIcons('rocket')).toContain('rocket')
  })
  it('空查询给分组内图标，且都属于该组', () => {
    const r = searchIcons('', 'pet')
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((k) => ICON_DATA[k].g === 'pet')).toBe(true)
  })
  it('数量有上限，没结果返回空', () => {
    expect(searchIcons('').length).toBeLessThanOrEqual(ICON_SEARCH_LIMIT)
    expect(searchIcons('zzzzqqq')).toEqual([])
  })
})

describe('outputName', () => {
  it('去非法字符并截断', () => {
    expect(outputName('山屿 咖啡')).toBe('logo-山屿咖啡.png')
    expect(outputName('a/b:c*')).toBe('logo-abc.png')
    expect(outputName('x'.repeat(40)).length).toBe('logo-.png'.length + 12)
  })
  it('空名回默认', () => {
    expect(outputName('  ')).toBe('logo.png')
  })
})
