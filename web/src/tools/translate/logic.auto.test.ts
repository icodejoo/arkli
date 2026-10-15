import { describe, expect, it } from 'vitest'
import { defaultPair, parsePair, unrecognizedTip } from './logic'

describe('翻译偏好里的 auto', () => {
  it('parsePair：源可以是 auto，目标不可以', () => {
    expect(parsePair('{"src":"auto","tgt":"zh-CN"}')).toEqual({ src: 'auto', tgt: 'zh-CN' })
    expect(parsePair('{"src":"en","tgt":"auto"}')).toEqual(defaultPair())
    expect(parsePair('{"src":"auto","tgt":"auto"}')).toEqual(defaultPair())
  })
  it('默认语言对仍是 en → zh-CN', () => {
    expect(defaultPair()).toEqual({ src: 'en', tgt: 'zh-CN' })
  })
  it('unrecognizedTip：仅 unrecognized 为真时有提示', () => {
    expect(unrecognizedTip(true)).toBe('部分字符无法识别')
    expect(unrecognizedTip(false)).toBe('')
    expect(unrecognizedTip(undefined)).toBe('')
  })
})
