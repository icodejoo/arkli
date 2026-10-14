import { describe, expect, it } from 'vitest'
import {
  clampFactor, createReader, currentChunk, describeError, INSTALL_GUIDE, langAvailable, LANG_OPTIONS, nextChunk, NO_ENGINE_GUIDE,
  progressLabel, splitText, usableLangs,
} from './logic'

describe('splitText', () => {
  it('短文本一整段，空白文本没有段', () => {
    expect(splitText('你好', 10)).toEqual(['你好'])
    expect(splitText('   ', 10)).toEqual([])
    expect(splitText('', 10)).toEqual([])
  })
  it('优先在句末断开', () => {
    expect(splitText('第一句。第二句。第三句。', 7)).toEqual(['第一句。', '第二句。', '第三句。'])
    expect(splitText('Hi! Ok? Yes.', 6)).toEqual(['Hi!', ' Ok?', ' Yes.'])
  })
  it('没有标点时在空白处断，再没有就硬切', () => {
    expect(splitText('hello world again', 7)).toEqual(['hello ', 'world ', 'again'])
    expect(splitText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })
  it('每段不超限且拼起来等于原文', () => {
    const text = ('这是一个很长的句子，没有结尾' + '。').repeat(600) + '尾巴'
    const parts = splitText(text, 8000)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= 8000)).toBe(true)
    expect(parts.join('')).toBe(text)
  })
  it('不劈开代理对（emoji）', () => {
    const parts = splitText('ab😀cd', 3)
    expect(parts.join('')).toBe('ab😀cd')
    expect(parts.every((p) => !/[\ud800-\udbff]$/.test(p))).toBe(true)
  })
  it('max 太小报错', () => {
    expect(() => splitText('abc', 1)).toThrow(RangeError)
  })
})

describe('clampFactor', () => {
  it('夹到 0.5~2，非数字回 1，两位小数', () => {
    expect(clampFactor(0.1)).toBe(0.5)
    expect(clampFactor(5)).toBe(2)
    expect(clampFactor('1.234')).toBe(1.23)
    expect(clampFactor('x')).toBe(1)
    expect(clampFactor(NaN)).toBe(1)
  })
})

describe('语言匹配', () => {
  it('主语言一致且地区兼容', () => {
    expect(langAvailable(['zh-CN', 'en-US'], 'zh-CN')).toBe(true)
    expect(langAvailable(['zh-CN'], 'zh-TW')).toBe(false)
    expect(langAvailable(['zh'], 'zh-TW')).toBe(true)
    expect(langAvailable(['en_US'], 'en-US')).toBe(true)
    expect(langAvailable(['en-US'], 'ja-JP')).toBe(false)
  })
  it('cmn 等同 zh，地区取两位字母子标签', () => {
    expect(langAvailable(['cmn-Hans-CN'], 'zh-CN')).toBe(true)
    expect(langAvailable(['cmn-Hant-TW'], 'zh-CN')).toBe(false)
  })
  it('usableLangs：引擎没报告时全部保留，否则筛选', () => {
    expect(usableLangs([])).toBe(LANG_OPTIONS)
    expect(usableLangs(['en-US', 'ja-JP']).map((o) => o.code)).toEqual(['en-US', 'ja-JP'])
  })
})

describe('错误提示', () => {
  it('NOT_READY 区分语音数据缺失与引擎不可用', () => {
    expect(describeError({ code: 'NOT_READY', message: '没有 zh-CN 的语音数据' })).toBe(INSTALL_GUIDE)
    expect(describeError({ code: 'NOT_READY', message: '文字转语音引擎不可用' })).toBe(NO_ENGINE_GUIDE)
    expect(describeError({ code: 'BAD_PARAMS', message: 'text 不能为空' })).toBe('text 不能为空')
    expect(describeError(null)).toBe('朗读失败')
  })
})

describe('顺序朗读进度', () => {
  it('依次读完每一段', () => {
    let r = createReader('第一句。第二句。第三句。', 5)
    expect(r.chunks).toHaveLength(3)
    const seen: string[] = []
    for (let c = currentChunk(r); c !== null; c = currentChunk(r)) {
      seen.push(c)
      r = nextChunk(r)
    }
    expect(seen.join('')).toBe('第一句。第二句。第三句。')
    expect(currentChunk(r)).toBeNull()
  })
  it('progressLabel：单段为空，多段显示 n / total', () => {
    expect(progressLabel(createReader('短文本'))).toBe('')
    const r = createReader('第一句。第二句。', 5)
    expect(progressLabel(r)).toBe('1 / 2')
    expect(progressLabel(nextChunk(r))).toBe('2 / 2')
    expect(progressLabel(nextChunk(nextChunk(r)))).toBe('2 / 2')
  })
  it('空文本没有可读内容', () => {
    expect(currentChunk(createReader('  '))).toBeNull()
  })
})
