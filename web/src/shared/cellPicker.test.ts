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

  it('toActions 透传 disabled，当前值被禁用时仍带 disabled', () => {
    const a = toActions([{ value: 1, label: '甲', disabled: true }, { value: 2, label: '乙', disabled: false }, { value: 3, label: '丙' }], 1, '#f00')
    expect(a).toEqual([
      { name: '甲', value: 1, color: '#f00', disabled: true },
      { name: '乙', value: 2, disabled: false },
      { name: '丙', value: 3 },
    ])
  })

  it('未设 disabled 时 action 不带该字段', () => {
    expect('disabled' in toActions(OPTS, 29, '#f00')[0]).toBe(false)
  })
})
