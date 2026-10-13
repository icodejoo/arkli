import { describe, expect, it } from 'vitest'
import { MAX_OPTIONS, parseOptions } from './options'

describe('parseOptions', () => {
  it('按换行与各种逗号分隔并去空白', () => {
    expect(parseOptions(' 甲,乙，丙、丁;戊\n\n 己 ').items).toEqual(['甲', '乙', '丙', '丁', '戊', '己'])
  })
  it('去重并计数', () => {
    const r = parseOptions('a\na\nb\na')
    expect(r.items).toEqual(['a', 'b'])
    expect(r.duplicates).toBe(2)
  })
  it('空输入得到空列表', () => {
    expect(parseOptions('  \n ,, ').items).toEqual([])
  })
  it('超上限截断', () => {
    const text = Array.from({ length: MAX_OPTIONS + 5 }, (_, i) => `x${i}`).join('\n')
    const r = parseOptions(text)
    expect(r.items).toHaveLength(MAX_OPTIONS)
    expect(r.truncated).toBe(true)
  })
})
