import { describe, expect, it } from 'vitest'
import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE } from '@/shared/image-calc'
import { alignX, BG_PRESETS, footerFontSize, footerHeight, gradientLine, layoutPages, maxPageHeight, paginate, wrapText, type LayoutOptions } from './logic'

/** 测试用测宽：半角（码点 < 0x2e80）5，其余（中文、emoji 簇的每个码点）10 */
const measure = (s: string): number => Array.from(s).reduce((w, c) => w + (c.codePointAt(0)! < 0x2e80 ? 5 : 10), 0)

describe('wrapText 中文', () => {
  it('按字符宽度换行', () => {
    expect(wrapText('一二三四五六七', 30, measure)).toEqual(['一二三', '四五六', '七'])
  })
  it('空文本返回空数组', () => {
    expect(wrapText('', 100, measure)).toEqual([])
  })
  it('\\n 分段，空行保留', () => {
    expect(wrapText('一二\n\n三', 100, measure)).toEqual(['一二', '', '三'])
  })
  it('兼容 \\r\\n', () => {
    expect(wrapText('一\r\n二', 100, measure)).toEqual(['一', '二'])
  })
})

describe('wrapText 英文', () => {
  it('按词换行，行尾空格不留', () => {
    expect(wrapText('hello world foo', 30, measure)).toEqual(['hello', 'world', 'foo'])
  })
  it('一行放得下多个词', () => {
    expect(wrapText('ab cd ef gh', 30, measure)).toEqual(['ab cd', 'ef gh'])
  })
  it('超长单词强拆', () => {
    expect(wrapText('abcdefghij', 25, measure)).toEqual(['abcde', 'fghij'])
  })
  it('长词前面有内容时先换行再强拆', () => {
    expect(wrapText('hi abcdefghij', 25, measure)).toEqual(['hi', 'abcde', 'fghij'])
  })
  it('行首空格仅在段首保留', () => {
    expect(wrapText('  ab', 100, measure)).toEqual(['  ab'])
  })
})

describe('wrapText 混排与禁则', () => {
  it('中英混排：英文词不被拆开', () => {
    expect(wrapText('中文abc中文', 20, measure)).toEqual(['中文', 'abc', '中文'])
  })
  it('句号逗号不出现在行首（悬挂）', () => {
    const lines = wrapText('一二三，四五六。', 30, measure)
    expect(lines).toEqual(['一二三，', '四五六。'])
    for (const l of lines) expect('，。！？'.indexOf(l[0])).toBe(-1)
  })
  it('开括号不出现在行尾', () => {
    expect(wrapText('一二（三四', 30, measure)).toEqual(['一二', '（三四'])
  })
  it('emoji（含 ZWJ 序列）不被拆开', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
    const lines = wrapText(`一${family}二`, 60, measure)
    expect(lines.join('')).toBe(`一${family}二`)
    expect(lines.some((l) => l.indexOf(family) >= 0)).toBe(true)
  })
  it('变体选择符并入前一字符', () => {
    const heart = '❤️'
    const lines = wrapText('一二三' + heart, 30, measure)
    expect(lines.join('')).toBe('一二三' + heart)
    expect(lines.every((l) => l !== '️')).toBe(true)
  })
  it('全角半角混排总字符不丢', () => {
    const src = 'A1，中ＡＢ文 test、完'
    expect(wrapText(src, 35, measure).join('').replace(/ /g, '')).toBe(src.replace(/ /g, ''))
  })
  it('单字符比行宽还宽时硬放一个，不死循环', () => {
    expect(wrapText('一二', 5, measure)).toEqual(['一', '二'])
  })
})

describe('paginate', () => {
  it('按行数切页', () => {
    expect(paginate(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']])
  })
  it('每页至少一行', () => {
    expect(paginate(['a', 'b'], 0)).toEqual([['a'], ['b']])
  })
  it('翻页处的前导空行、页尾空行去掉', () => {
    expect(paginate(['a', '', '', 'b', 'c'], 2)).toEqual([['a'], ['b'], ['c']])
    expect(paginate(['a', 'b', '', 'c'], 3)).toEqual([['a', 'b'], ['c']])
  })
  it('空数组无页', () => {
    expect(paginate([], 5)).toEqual([])
  })
})

describe('maxPageHeight', () => {
  it('窄图受单边上限', () => {
    expect(maxPageHeight(1000, 0)).toBe(MAX_CANVAS_SIDE)
  })
  it('宽图受总像素上限', () => {
    expect(maxPageHeight(10000, 0)).toBe(Math.floor(MAX_CANVAS_PIXELS / 10000))
  })
  it('用户上限更小时取用户上限', () => {
    expect(maxPageHeight(1000, 2000)).toBe(2000)
  })
})

describe('footer', () => {
  it('字号有下限', () => {
    expect(footerFontSize(10)).toBe(12)
    expect(footerFontSize(40)).toBe(24)
  })
  it('无页脚高度为 0', () => {
    expect(footerHeight(40, '')).toBe(0)
    expect(footerHeight(40, '水印')).toBe(58)
  })
})

describe('alignX', () => {
  it('三种对齐', () => {
    expect(alignX('left', 40, 400, 100)).toBe(40)
    expect(alignX('center', 40, 400, 100)).toBe(190)
    expect(alignX('right', 40, 400, 100)).toBe(340)
  })
})

describe('layoutPages', () => {
  const opts: LayoutOptions = { width: 100, fontSize: 10, lineHeightRatio: 1.5, padding: 10, heightCap: 0, footer: '' }
  it('单页：高度 = 上下边距 + 行数 × 行高', () => {
    const pages = layoutPages('一二三四', opts, measure)
    expect(pages).toHaveLength(1)
    expect(pages[0].width).toBe(100)
    expect(pages[0].height).toBe(20 + 15)
  })
  it('超出高度上限自动分页，每页不超上限', () => {
    const pages = layoutPages('一二三四五六七八九十', { ...opts, width: 30, padding: 5, heightCap: 60 }, measure)
    // 内容宽 20：每行 2 字，共 5 行；每页 (60-10)/15 = 3 行
    expect(pages.map((p) => p.lines.length)).toEqual([3, 2])
    for (const p of pages) expect(p.height).toBeLessThanOrEqual(60)
  })
  it('有页脚时每页预留页脚高度', () => {
    const withFoot = layoutPages('一二', { ...opts, footer: 'x' }, measure)
    const noFoot = layoutPages('一二', opts, measure)
    expect(withFoot[0].height - noFoot[0].height).toBe(footerHeight(10, 'x'))
  })
  it('空文本无页', () => {
    expect(layoutPages('', opts, measure)).toEqual([])
  })
})

describe('gradientLine / BG_PRESETS', () => {
  it('90 度从左到右', () => {
    expect(gradientLine(100, 100, 90)).toEqual({ x0: 0, y0: 50, x1: 100, y1: 50 })
  })
  it('预设色值合法', () => {
    for (const p of BG_PRESETS) {
      expect(p.c1).toMatch(/^#[0-9a-f]{6}$/i)
      expect(p.c2).toMatch(/^#[0-9a-f]{6}$/i)
      expect(p.text).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})
