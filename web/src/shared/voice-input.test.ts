import { describe, expect, it } from 'vitest'
import { applyFinal, applyPartial, clampLength, dictationText, joinText, rebase, startDictation } from './voice-input'

describe('joinText', () => {
  it('空串直接返回另一段', () => {
    expect(joinText('', 'a')).toBe('a')
    expect(joinText('a', '')).toBe('a')
  })
  it('交界两侧都是字母数字补空格，其余直连', () => {
    expect(joinText('hello', 'world')).toBe('hello world')
    expect(joinText('你好', 'world')).toBe('你好world')
    expect(joinText('hello', '你好')).toBe('hello你好')
    expect(joinText('a。', 'b')).toBe('a。b')
  })
})

describe('听写文本状态', () => {
  it('中间结果追加在已有文本后面，且不覆盖已有文本', () => {
    let s = startDictation('已有：')
    s = applyPartial(s, '你')
    expect(dictationText(s)).toBe('已有：你')
    s = applyPartial(s, '你好')
    expect(dictationText(s)).toBe('已有：你好')
  })
  it('定稿固化并清空中间结果，多句相接', () => {
    let s = startDictation('')
    s = applyPartial(s, '你好')
    s = applyFinal(s, '你好。')
    expect(s.partial).toBe('')
    s = applyPartial(s, 'hello')
    expect(dictationText(s)).toBe('你好。hello')
    s = applyFinal(s, 'hello')
    s = applyFinal(s, 'world')
    expect(dictationText(s)).toBe('你好。hello world')
  })
  it('空白定稿只清中间结果', () => {
    const s = applyFinal(applyPartial(startDictation('x'), '噪'), '  ')
    expect(dictationText(s)).toBe('x')
  })
  it('用户听写中自己改了文本：以新文本为基准，不重复追加旧定稿', () => {
    let s = applyFinal(startDictation('a'), '你好。')
    s = rebase(s, 'a你好。改')
    s = applyPartial(s, '再')
    expect(dictationText(s)).toBe('a你好。改再')
  })
})

describe('clampLength', () => {
  it('超长截断，未设置或非法不截断', () => {
    expect(clampLength('12345', 3)).toBe('123')
    expect(clampLength('12345', '4')).toBe('1234')
    expect(clampLength('12345', undefined)).toBe('12345')
    expect(clampLength('12345', 0)).toBe('12345')
    expect(clampLength('12345', 'x')).toBe('12345')
  })
})
