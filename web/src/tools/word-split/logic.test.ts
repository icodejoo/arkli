import { describe, expect, it } from 'vitest'
import { createSegmenter, joinSelected, selectAllWords, tokenize, toggleIndex, type SegmenterLike } from './logic'

/** 假分词器：按空格切，纯空格片段标为非词 */
const fake: SegmenterLike = {
  segment: (s) => s.split(/( )/).filter(Boolean).map((p) => ({ segment: p, isWordLike: p !== ' ' })),
}

describe('createSegmenter', () => {
  it('返回分词器或 null，不抛错', () => {
    const s = createSegmenter()
    expect(s === null || typeof s.segment === 'function').toBe(true)
  })
})

describe('tokenize', () => {
  it('空串返回空数组', () => expect(tokenize('', null)).toEqual([]))
  it('无分词器按字拆，标点非词', () => {
    expect(tokenize('你好，a', null)).toEqual([
      { text: '你', isWord: true },
      { text: '好', isWord: true },
      { text: '，', isWord: false },
      { text: 'a', isWord: true },
    ])
  })
  it('按码点拆，emoji 不劈开', () => expect(tokenize('😀', null)).toHaveLength(1))
  it('使用注入的分词器', () => {
    expect(tokenize('ab cd', fake).map((t) => t.text)).toEqual(['ab', ' ', 'cd'])
    expect(tokenize('ab cd', fake)[1].isWord).toBe(false)
  })
  it('片段拼起来等于原文', () => {
    const s = '今天天气不错，出去走走！'
    expect(tokenize(s).map((t) => t.text).join('')).toBe(s)
  })
})

describe('joinSelected', () => {
  const toks = tokenize('我爱你', null)
  it('按原顺序拼接', () => expect(joinSelected(toks, new Set([2, 0]))).toBe('我你'))
  it('自定义分隔符', () => expect(joinSelected(toks, new Set([0, 1]), ' ')).toBe('我 爱'))
  it('无选中为空串', () => expect(joinSelected(toks, new Set())).toBe(''))
})

describe('toggleIndex', () => {
  it('增删且不改原集合', () => {
    const a = new Set([1])
    expect(Array.from(toggleIndex(a, 2))).toEqual([1, 2])
    expect(Array.from(toggleIndex(a, 1))).toEqual([])
    expect(a.size).toBe(1)
  })
})

describe('selectAllWords', () => {
  it('跳过标点', () => expect(Array.from(selectAllWords(tokenize('你好，', null)))).toEqual([0, 1]))
  it('空输入为空集', () => expect(selectAllWords([]).size).toBe(0))
})
