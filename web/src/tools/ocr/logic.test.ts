import { describe, expect, it } from 'vitest'
import type { OcrBlock } from '@/native/ai'
import { averageScore, groupLines, joinTexts, lineIndexAt, linesToText } from './logic'

/** 造一个横排文字块：左上 (x,y)，宽 w，高 h */
function blk(text: string, x: number, y: number, w = 40, h = 20, score = 0.9): OcrBlock {
  return { text, box: [x, y, x + w, y, x + w, y + h, x, y + h], score }
}

describe('joinTexts', () => {
  it('中文相连，英文加空格，空串跳过', () => {
    expect(joinTexts(['你好', '世界'])).toBe('你好世界')
    expect(joinTexts(['a', 'b'])).toBe('a b')
    expect(joinTexts(['你好', 'abc', '世界'])).toBe('你好 abc 世界')
    expect(joinTexts(['', 'x', ''])).toBe('x')
  })
})

describe('groupLines', () => {
  it('乱序输入按行聚类，行内按 x 排', () => {
    const lines = groupLines([blk('世界', 60, 2), blk('第二行', 0, 40), blk('你好', 0, 0)])
    expect(lines.map((l) => l.text)).toEqual(['你好世界', '第二行'])
  })
  it('轻微倾斜（y 有小偏移）仍算一行', () => {
    const lines = groupLines([blk('A', 0, 0), blk('B', 50, 4), blk('C', 100, 8)])
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('A B C')
  })
  it('行距足够时分成多行', () => {
    expect(groupLines([blk('a', 0, 0), blk('b', 0, 30), blk('c', 0, 60)])).toHaveLength(3)
  })
  it('空白文字块被丢弃；空输入返回空', () => {
    expect(groupLines([blk('  ', 0, 0)])).toEqual([])
    expect(groupLines([])).toEqual([])
  })
  it('高度差异大的小字不被并进大字行', () => {
    const lines = groupLines([blk('大标题', 0, 0, 100, 60), blk('脚注', 0, 50, 30, 10)])
    expect(lines).toHaveLength(2)
  })
})

describe('linesToText', () => {
  it('按行换行', () => {
    expect(linesToText(groupLines([blk('a', 0, 0), blk('b', 0, 40)]))).toBe('a\nb')
    expect(linesToText([])).toBe('')
  })
})

describe('lineIndexAt', () => {
  const lines = groupLines([blk('a', 0, 0), blk('b', 0, 40)])
  it('点中返回行下标，没点中 -1', () => {
    expect(lineIndexAt(lines, 10, 50)).toBe(1)
    expect(lineIndexAt(lines, 10, 10)).toBe(0)
    expect(lineIndexAt(lines, 500, 500)).toBe(-1)
  })
})

describe('averageScore', () => {
  it('平均值与空', () => {
    expect(averageScore([blk('a', 0, 0, 1, 1, 0.8), blk('b', 0, 0, 1, 1, 0.6)])).toBeCloseTo(0.7)
    expect(averageScore([])).toBe(0)
  })
})
