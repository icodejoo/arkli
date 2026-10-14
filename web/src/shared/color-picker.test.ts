import { describe, expect, it } from 'vitest'
import { COLOR_PRESETS, hexToHsv, hsvToHex, ratioIn, toHex6 } from './color-picker'

describe('项目规则：颜色选择统一用 ColorPicker', () => {
  it('除 ColorPicker 自身外，.vue 里不许出现原生 type="color"', () => {
    const files = import.meta.glob('../**/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const bad = Object.entries(files)
      .filter(([p, src]) => !p.endsWith('/ColorPicker.vue') && /type=["']color["']/.test(src))
      .map(([p]) => p)
    expect(bad).toEqual([])
  })
})

describe('toHex6', () => {
  it('规整各种写法为小写 6 位 HEX', () => {
    expect(toHex6('#FFF')).toBe('#ffffff')
    expect(toHex6('3B6CF6')).toBe('#3b6cf6')
    expect(toHex6('rgb(255, 0, 0)')).toBe('#ff0000')
  })
  it('带透明度时丢掉透明度', () => {
    expect(toHex6('#ff000080')).toBe('#ff0000')
  })
  it('认不出返回 null', () => {
    expect(toHex6('')).toBeNull()
    expect(toHex6('hello')).toBeNull()
  })
})

describe('HSV 互转', () => {
  it('纯红往返一致', () => {
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 100, v: 100 })
    expect(hsvToHex({ h: 0, s: 100, v: 100 })).toBe('#ff0000')
  })
  it('预设色往返不丢', () => {
    for (const c of COLOR_PRESETS) expect(hsvToHex(hexToHsv(c))).toBe(c)
  })
  it('非法 HEX 回落白色', () => {
    expect(hexToHsv('nope')).toEqual({ h: 0, s: 0, v: 100 })
  })
})

describe('ratioIn', () => {
  it('按位置换比例并夹住', () => {
    expect(ratioIn(150, 100, 200)).toBe(0.25)
    expect(ratioIn(50, 100, 200)).toBe(0)
    expect(ratioIn(999, 100, 200)).toBe(1)
    expect(ratioIn(10, 0, 0)).toBe(0)
  })
})
