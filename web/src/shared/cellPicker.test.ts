import { describe, expect, it } from 'vitest'
import { optionLabel, toActions } from './cellPicker'

const OPTS = [
  { value: 29, label: '29×29' },
  { value: 'custom', label: '自定义' },
]

describe('cellPicker', () => {
  it('optionLabel 取当前文案，找不到为空', () => {
    expect(optionLabel(OPTS, 29)).toBe('29×29')
    expect(optionLabel(OPTS, 'custom')).toBe('自定义')
    expect(optionLabel(OPTS, 1)).toBe('')
  })

  it('toActions 只高亮选中项并带回原值', () => {
    const a = toActions(OPTS, 29, '#f00')
    expect(a).toEqual([
      { name: '29×29', value: 29, color: '#f00' },
      { name: '自定义', value: 'custom' },
    ])
  })
})
