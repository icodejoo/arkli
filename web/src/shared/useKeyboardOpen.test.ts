import { describe, expect, it } from 'vitest'
import { KB_CLASS, KB_EVENT } from './useKeyboardOpen'

describe('键盘事件约定', () => {
  it('名字与原生 SafeInsets 保持一致', () => {
    expect(KB_EVENT).toBe('arkli-keyboard')
    expect(KB_CLASS).toBe('kb-open')
  })
})
