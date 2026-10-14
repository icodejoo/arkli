import { describe, expect, it } from 'vitest'
import type { OcrBlock } from '@/native/ai'
import {
  blocksToTable,
  CSV_BOM,
  estimateSkew,
  median,
  normalizeTable,
  removeColumn,
  removeRow,
  rotateBox,
  textToTable,
  toCsv,
  toTsv,
  updateCell,
} from './logic'

/** 造一个正矩形文字块 */
function blk(text: string, x: number, y: number, w = 60, h = 20): OcrBlock {
  return { text, box: [x, y, x + w, y, x + w, y + h, x, y + h], score: 0.9 }
}

/** 三列 x 起点 */
const COL_X = [0, 100, 200]

/** 按行列文本造一张规整的表 */
function grid(cells: string[][], rowGap = 40): OcrBlock[] {
  const out: OcrBlock[] = []
  cells.forEach((r, i) => r.forEach((t, j) => t && out.push(blk(t, COL_X[j], i * rowGap))))
  return out
}

describe('median', () => {
  it('奇偶与空', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('blocksToTable', () => {
  it('规整 3×3，乱序输入也能还原', () => {
    const cells = [
      ['姓名', '年龄', '城市'],
      ['张三', '20', '北京'],
      ['李四', '31', '上海'],
    ]
    const blocks = grid(cells).reverse()
    expect(blocksToTable(blocks)).toEqual(cells)
  })
  it('空单元格保留为空串', () => {
    const cells = [
      ['a', 'b', 'c'],
      ['d', '', 'f'],
    ]
    expect(blocksToTable(grid(cells))).toEqual(cells)
  })
  it('行内 y 有小抖动仍归为同一行', () => {
    const blocks = [blk('a', 0, 0), blk('b', 100, 5), blk('c', 200, -4), blk('d', 0, 40), blk('e', 100, 44)]
    expect(blocksToTable(blocks)).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', ''],
    ])
  })
  it('跨列表头放进最左列，不把两列粘成一列', () => {
    const blocks = [
      blk('成绩汇总表', 0, 0, 160),
      ...grid([
        ['科目', '分数', '等级'],
        ['语文', '90', '优'],
      ]).map((x) => ({ ...x, box: x.box.map((v, i) => (i % 2 ? v + 40 : v)) })),
    ]
    const t = blocksToTable(blocks)
    expect(t[0]).toEqual(['成绩汇总表', '', ''])
    expect(t[1]).toEqual(['科目', '分数', '等级'])
    expect(t[2]).toEqual(['语文', '90', '优'])
  })
  it('右对齐的数字列（宽度不同）仍是一列', () => {
    const blocks = [blk('名称', 0, 0), blk('金额', 100, 0, 60), blk('米', 0, 40), blk('5', 150, 40, 10), blk('面', 0, 80), blk('12345', 110, 80, 50)]
    expect(blocksToTable(blocks)).toEqual([
      ['名称', '金额'],
      ['米', '5'],
      ['面', '12345'],
    ])
  })
  it('同一单元格多个块用空格拼接', () => {
    const blocks = [blk('Hello', 0, 0, 40), blk('World', 45, 0, 40), blk('x', 200, 0)]
    expect(blocksToTable(blocks)).toEqual([['Hello World', 'x']])
  })
  it('整体倾斜（旋转框）可被摆正', () => {
    const angle = 0.06
    const cells = [
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
      ['G', 'H', 'I'],
    ]
    const rot = (x: number, y: number): [number, number] => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)]
    const blocks: OcrBlock[] = []
    cells.forEach((r, i) =>
      r.forEach((t, j) => {
        const x = COL_X[j] + 300
        const y = i * 40 + 100
        const pts = [rot(x, y), rot(x + 60, y), rot(x + 60, y + 20), rot(x, y + 20)]
        blocks.push({ text: t, box: pts.flat(), score: 1 })
      }),
    )
    expect(estimateSkew(blocks)).toBeCloseTo(angle, 3)
    expect(blocksToTable(blocks)).toEqual(cells)
  })
  it('空输入、纯空白文字返回 []', () => {
    expect(blocksToTable([])).toEqual([])
    expect(blocksToTable([blk('  ', 0, 0)])).toEqual([])
  })
})

describe('estimateSkew / rotateBox', () => {
  it('正矩形为 0，不可信的大角度为 0', () => {
    expect(estimateSkew([blk('a', 0, 0)])).toBe(0)
    expect(estimateSkew([{ text: 'a', box: [0, 0, 10, 20, 10, 30, 0, 10], score: 1 }])).toBe(0)
  })
  it('旋转 0 原样，转 90 度', () => {
    expect(rotateBox([1, 2, 3, 4], 0)).toEqual([1, 2, 3, 4])
    const r = rotateBox([1, 0], Math.PI / 2)
    expect(r[0]).toBeCloseTo(0)
    expect(r[1]).toBeCloseTo(-1)
  })
})

describe('normalizeTable', () => {
  it('补齐、去首尾空白、去全空行列', () => {
    expect(normalizeTable([[' a ', ''], ['b'], ['', '']])).toEqual([['a'], ['b']])
    expect(normalizeTable([['', '']])).toEqual([])
    expect(normalizeTable([['a'], ['b', 'c']])).toEqual([
      ['a', ''],
      ['b', 'c'],
    ])
  })
})

describe('textToTable', () => {
  it('按任意空白拆', () => {
    expect(textToTable('姓名 年龄\n张三 20')).toEqual([
      ['姓名', '年龄'],
      ['张三', '20'],
    ])
  })
  it('有制表符时按制表符拆，保留格内空格', () => {
    expect(textToTable('New York\t10\nParis\t20')).toEqual([
      ['New York', '10'],
      ['Paris', '20'],
    ])
  })
  it('有连续多空格时按多空格拆', () => {
    expect(textToTable('New York   10\nParis   20')).toEqual([
      ['New York', '10'],
      ['Paris', '20'],
    ])
  })
  it('CRLF、空行、空文本', () => {
    expect(textToTable('a b\r\n\r\nc d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(textToTable('')).toEqual([])
    expect(textToTable('  \n  ')).toEqual([])
  })
})

describe('toTsv', () => {
  it('制表符分列、换行分行，格内制表/换行变空格', () => {
    expect(toTsv([['a', 'b'], ['1', '2']])).toBe('a\tb\n1\t2')
    expect(toTsv([['x\ty', 'm\nn']])).toBe('x y\tm n')
    expect(toTsv([])).toBe('')
  })
})

describe('toCsv', () => {
  it('含逗号、引号、换行的格子加引号并翻倍引号', () => {
    expect(toCsv([['a,b', 'say "hi"', 'l1\nl2', 'plain']])).toBe('"a,b","say ""hi""","l1\nl2",plain')
  })
  it('多行用 CRLF；可选 BOM', () => {
    expect(toCsv([['a'], ['b']])).toBe('a\r\nb')
    expect(toCsv([['中']], true)).toBe(CSV_BOM + '中')
    expect(toCsv([['中']]).charCodeAt(0)).not.toBe(0xfeff)
  })
})

describe('编辑', () => {
  const t = [
    ['a', 'b'],
    ['c', 'd'],
  ]
  it('updateCell 不改原数组，越界原样返回', () => {
    expect(updateCell(t, 1, 0, 'X')).toEqual([['a', 'b'], ['X', 'd']])
    expect(t[1][0]).toBe('c')
    expect(updateCell(t, 5, 0, 'X')).toBe(t)
    expect(updateCell(t, 0, 9, 'X')).toBe(t)
  })
  it('removeRow / removeColumn', () => {
    expect(removeRow(t, 0)).toEqual([['c', 'd']])
    expect(removeColumn(t, 1)).toEqual([['a'], ['c']])
    expect(removeColumn([['a']], 0)).toEqual([])
  })
})
