import { describe, expect, it } from 'vitest'
import {
  aggregateText,
  aggregateTranslated,
  boxToRect,
  cancelProgress,
  displayScale,
  finishOne,
  fitFontSize,
  initProgress,
  itemPairsText,
  MAX_BLOCKS_PER_IMAGE,
  MIN_FONT_PX,
  overlayCss,
  overlayStyle,
  progressPercent,
  progressText,
  usableBlocks,
  type PhotoItemResult,
} from './photoLogic'

/** 造一张结果 */
function item(blocks: Array<[string, string]>, name = 'a.jpg'): PhotoItemResult {
  return { name, url: '', width: 100, height: 100, status: 'done', blocks: blocks.map(([src, tgt]) => ({ src, tgt, box: [] })) }
}

describe('boxToRect / displayScale', () => {
  it('外接矩形，倾斜框取包络', () => {
    expect(boxToRect([10, 20, 110, 20, 110, 50, 10, 50])).toEqual({ x: 10, y: 20, w: 100, h: 30 })
    expect(boxToRect([12, 22, 110, 18, 108, 52, 10, 50])).toEqual({ x: 10, y: 18, w: 100, h: 34 })
  })
  it('坐标不足 8 个数返回零矩形', () => {
    expect(boxToRect([1, 2])).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
  it('缩放比 = 显示宽/基准宽，无效回 1', () => {
    expect(displayScale(1000, 500)).toBe(0.5)
    expect(displayScale(0, 500)).toBe(1)
    expect(displayScale(1000, 0)).toBe(1)
  })
})

describe('overlayStyle / fitFontSize', () => {
  it('按缩放换算到显示像素', () => {
    const s = overlayStyle([100, 40, 300, 40, 300, 80, 100, 80], 0.5, 'Hi')
    expect(s).toMatchObject({ left: 50, top: 20, width: 100, height: 20 })
  })
  it('字号不超过框高比例', () => {
    expect(fitFontSize('你', 200, 20)).toBeCloseTo(16.4, 5)
  })
  it('文字多时按面积收缩，且有下限', () => {
    const long = '很长的一段译文'.repeat(20)
    expect(fitFontSize(long, 100, 20)).toBe(MIN_FONT_PX)
    expect(fitFontSize('中等长度的译文啊', 100, 40)).toBeLessThan(40 * 0.82)
  })
  it('空文本不除零', () => {
    expect(Number.isFinite(fitFontSize('', 50, 20))).toBe(true)
  })
  it('overlayCss 带 px 单位', () => {
    expect(overlayCss({ left: 1, top: 2, width: 3, height: 4, fontSize: 5 })).toEqual({ left: '1px', top: '2px', width: '3px', height: '4px', fontSize: '5px' })
  })
})

describe('usableBlocks', () => {
  it('trim、丢空文本、限制数量', () => {
    const blocks = [
      { text: ' a ', box: [], score: 1 },
      { text: '   ', box: [], score: 1 },
      { text: 'b', box: [], score: 1 },
    ]
    expect(usableBlocks(blocks).map((b) => b.text)).toEqual(['a', 'b'])
    expect(usableBlocks(blocks, 1)).toHaveLength(1)
    const many = Array.from({ length: MAX_BLOCKS_PER_IMAGE + 5 }, () => ({ text: 'x', box: [], score: 1 }))
    expect(usableBlocks(many)).toHaveLength(MAX_BLOCKS_PER_IMAGE)
  })
})

describe('聚合文本', () => {
  it('单张不加标题，原文译文成对', () => {
    expect(itemPairsText(item([['Hi', '你好'], ['Bye', '再见']]))).toBe('Hi\n你好\n\nBye\n再见')
    expect(aggregateText([item([['Hi', '你好']])])).toBe('Hi\n你好')
  })
  it('多张按图分组并跳过无文字的图', () => {
    const all = aggregateText([item([['Hi', '你好']]), item([]), item([['Bye', '再见']])])
    expect(all).toBe('第 1 张\nHi\n你好\n\n第 3 张\nBye\n再见')
  })
  it('失败块只列原文；全空为空串', () => {
    expect(itemPairsText(item([['oops', '']]))).toBe('oops')
    expect(aggregateText([item([])])).toBe('')
  })
  it('仅译文聚合', () => {
    expect(aggregateTranslated([item([['Hi', '你好'], ['x', '']]), item([['Bye', '再见']])])).toBe('你好\n再见')
  })
})

describe('进度', () => {
  it('初始与推进', () => {
    let p = initProgress(3)
    expect(p).toEqual({ total: 3, finished: 0, failed: 0, current: 0, cancelled: false })
    expect(progressText(p)).toBe('正在处理第 1/3 张')
    p = finishOne(p, true)
    p = finishOne(p, false)
    expect(p).toMatchObject({ finished: 2, failed: 1, current: 2 })
    expect(progressPercent(p)).toBe(67)
    p = finishOne(p, true)
    expect(p.current).toBe(-1)
    expect(progressText(p)).toBe('完成，1 张失败')
  })
  it('全成功汇总文案与空任务', () => {
    expect(progressText(finishOne(initProgress(1), true))).toBe('完成，共 1 张')
    expect(initProgress(0).current).toBe(-1)
    expect(progressPercent(initProgress(0))).toBe(0)
  })
  it('取消后不再前进', () => {
    const p = cancelProgress(finishOne(initProgress(4), true))
    expect(p).toMatchObject({ cancelled: true, current: -1, finished: 1 })
    expect(progressText(p)).toBe('已取消，完成 1/4 张')
    expect(finishOne(p, true).current).toBe(-1)
  })
  it('不改入参', () => {
    const p = initProgress(2)
    finishOne(p, false)
    expect(p.finished).toBe(0)
  })
})
