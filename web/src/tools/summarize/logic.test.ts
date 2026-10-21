import { describe, expect, it } from 'vitest'
import { isValidN, MAX_N, pageRank, similarity, splitSentences, summarize, tokenizeForRank } from './logic'

describe('splitSentences', () => {
  it('按中文标点分句并保留标点', () => {
    expect(splitSentences('今天晴。明天呢？好！')).toEqual(['今天晴。', '明天呢？', '好！'])
  })
  it('英文标点与换行', () => {
    expect(splitSentences('Hi there. How are you?\nFine')).toEqual(['Hi there.', 'How are you?', 'Fine'])
  })
  it('连续标点、引号收尾归到本句', () => {
    expect(splitSentences('他说“走吧！”然后走了。')).toEqual(['他说“走吧！”', '然后走了。'])
    expect(splitSentences('真的吗？！')).toEqual(['真的吗？！'])
  })
  it('空串与纯空白返回空数组', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences(' \n ')).toEqual([])
  })
})

describe('tokenizeForRank', () => {
  it('中文取相邻两字', () => expect(Array.from(tokenizeForRank('天气好'))).toEqual(['天气', '气好']))
  it('英文按词并转小写', () => expect(Array.from(tokenizeForRank('Hello World 2'))).toEqual(['hello', 'world', '2']))
  it('落单汉字取单字', () => expect(Array.from(tokenizeForRank('a好b'))).toEqual(['a', 'b', '好']))
  it('只有标点为空集', () => expect(tokenizeForRank('，。！').size).toBe(0))
})

describe('similarity', () => {
  it('无公共词为 0，空集为 0', () => {
    expect(similarity(new Set(['a']), new Set(['b']))).toBe(0)
    expect(similarity(new Set(), new Set(['a']))).toBe(0)
  })
  it('有公共词为正，且对称', () => {
    const a = new Set(['a', 'b', 'c'])
    const b = new Set(['b', 'c', 'd'])
    expect(similarity(a, b)).toBeGreaterThan(0)
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a))
  })
  it('两个单词项相同不除零', () => expect(similarity(new Set(['a']), new Set(['a']))).toBe(1))
})

describe('pageRank', () => {
  it('空矩阵返回空数组', () => expect(pageRank([])).toEqual([]))
  it('对称两节点分数相等', () => {
    const r = pageRank([[0, 1], [1, 0]])
    expect(r[0]).toBeCloseTo(r[1])
  })
  it('被更多节点连接的分数更高', () => {
    const r = pageRank([
      [0, 1, 1],
      [1, 0, 0],
      [1, 0, 0],
    ])
    expect(r[0]).toBeGreaterThan(r[1])
  })
  it('孤立节点不会产生 NaN', () => {
    expect(pageRank([[0, 0], [0, 0]]).every((v) => Number.isFinite(v))).toBe(true)
  })
})

describe('summarize', () => {
  const text =
    '人工智能正在改变生活。人工智能技术让生活变得更加便利。今天中午我吃了一碗面。' +
    '很多人认为人工智能技术会改变生活和工作。天气预报说明天有雨。'

  it('返回 n 句且保持原文顺序', () => {
    const r = summarize(text, 2)
    expect(r.sentences).toHaveLength(2)
    expect(r.total).toBe(5)
    const all = splitSentences(text)
    const pos = r.sentences.map((s) => all.indexOf(s))
    expect(pos).toEqual(pos.slice().sort((a, b) => a - b))
  })
  it('主题相关的句子优先于无关句', () => {
    const r = summarize(text, 3).sentences.join('')
    expect(r).not.toContain('一碗面')
    expect(r).toContain('人工智能')
  })
  it('句数不够时返回全部', () => {
    expect(summarize('只有一句话。', 3).sentences).toEqual(['只有一句话。'])
  })
  it('空文本返回空摘要', () => expect(summarize('', 2)).toEqual({ sentences: [], total: 0 }))
  it('结果稳定可重复', () => expect(summarize(text, 2)).toEqual(summarize(text, 2)))
  it('n 非法抛错', () => {
    expect(() => summarize(text, 0)).toThrow(RangeError)
    expect(() => summarize(text, 1.5)).toThrow(RangeError)
  })
})

describe('isValidN', () => {
  it('只认 1..MAX_N 的整数', () => {
    expect(isValidN(3)).toBe(true)
    expect(isValidN(MAX_N)).toBe(true)
    expect(isValidN(0)).toBe(false)
    expect(isValidN(MAX_N + 1)).toBe(false)
    expect(isValidN(2.5)).toBe(false)
  })
})
