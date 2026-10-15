import { describe, expect, it } from 'vitest'
import { DEFAULT_SRC, DEFAULT_TGT, TEXT_MAX } from './data'
import { isLang } from '@/shared/languages'

describe('翻译常量', () => {
  it('长度上限为 2000', () => {
    expect(TEXT_MAX).toBe(2000)
  })
  it('默认语言对在目录里且不同', () => {
    expect(isLang(DEFAULT_SRC)).toBe(true)
    expect(isLang(DEFAULT_TGT)).toBe(true)
    expect(DEFAULT_SRC).not.toBe(DEFAULT_TGT)
  })
})
