/**
 * 图片提取表格的纯逻辑：OCR 文字框 → 行列聚类 → 二维数组；纯文本拆表；TSV / CSV 导出。
 * 不依赖 DOM，输入输出都是普通数据。
 */
import type { OcrBlock } from '@/native/ai'
import { boxRect, type BoxRect } from '@/tools/_ai/ocrBox'

/** 同一行判定：中心 y 与行均值之差不超过较小高度的这个比例 */
const ROW_TOLERANCE = 0.6
/** 列间距容忍：两列区间的空隙小于中位高度的这个比例时合并 */
const COLUMN_GAP_RATIO = 0.3
/** 跨列判定：与某列的重叠不少于该列/块较窄者宽度的这个比例才算「压到这一列」 */
const SPAN_OVERLAP_RATIO = 0.3
/** 倾斜角估计的上限（弧度，约 28 度），超过视为不可信 */
const MAX_SKEW = 0.5
/** CSV 文件头 BOM，防止 Excel 里中文乱码 */
export const CSV_BOM = '﻿'
/** 单元格内的制表符、换行统一替换成的字符 */
const CELL_SEP_REPLACE = ' '

/** 带坐标的文字块（已摆正） */
interface Item {
  /** 文字 */
  text: string
  /** 摆正后的外接矩形 */
  r: BoxRect
}

/** 一列的横向区间 */
interface Column {
  /** 左 */
  x1: number
  /** 右 */
  x2: number
}

/**
 * 取中位数。
 *
 * @param nums 数组（不会被修改）
 * @returns 中位数；空数组返回 0
 * @example median([3, 1, 2]) // 2
 */
export function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = nums.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * 估计整张表的倾斜角：取各文字框上边缘方向的中位数。
 *
 * @param blocks OCR 文字块
 * @returns 弧度，顺时针（y 向下）为正；框都是正矩形或不可信时为 0
 * @example estimateSkew([{ text: 'a', box: [0,0,100,10,100,30,0,20], score: 1 }]) // ≈ 0.0997
 */
export function estimateSkew(blocks: OcrBlock[]): number {
  const angles: number[] = []
  for (const b of blocks) {
    if (b.box.length < 8) continue
    const dx = b.box[2] - b.box[0]
    const dy = b.box[3] - b.box[1]
    if (dx > 0 && dx >= Math.abs(dy)) angles.push(Math.atan2(dy, dx))
  }
  const a = median(angles)
  return Math.abs(a) > MAX_SKEW ? 0 : a
}

/**
 * 把框绕原点旋转 -angle，用来摆正倾斜的表。
 *
 * @param box 四点框
 * @param angle 倾斜角（弧度）
 * @returns 旋转后的框
 * @example rotateBox([0, 0, 10, 0, 10, 4, 0, 4], 0) // 原样
 */
export function rotateBox(box: number[], angle: number): number[] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const out: number[] = []
  for (let i = 0; i + 1 < box.length; i += 2) {
    out.push(box[i] * c + box[i + 1] * s, -box[i] * s + box[i + 1] * c)
  }
  return out
}

/**
 * 按纵向位置把文字聚成行（行内按左边缘排序）。
 *
 * @param items 带矩形的文字块
 * @returns 从上到下的行
 */
function clusterRows(items: Item[]): Item[][] {
  const sorted = items.slice().sort((a, b) => a.r.cy - b.r.cy)
  const rows: Array<{ items: Item[]; cy: number; h: number }> = []
  for (const it of sorted) {
    const cur = rows[rows.length - 1]
    if (cur && Math.abs(it.r.cy - cur.cy) <= ROW_TOLERANCE * Math.min(it.r.h, cur.h)) {
      cur.items.push(it)
      const n = cur.items.length
      cur.cy += (it.r.cy - cur.cy) / n
      cur.h += (it.r.h - cur.h) / n
    } else {
      rows.push({ items: [it], cy: it.r.cy, h: it.r.h })
    }
  }
  return rows.map((r) => r.items.sort((a, b) => a.r.x1 - b.r.x1))
}

/** 区间重叠长度（不重叠为负的空隙） */
function overlapOf(a: Column, x1: number, x2: number): number {
  return Math.min(a.x2, x2) - Math.max(a.x1, x1)
}

/**
 * 根据文字块的横向区间求列：先放窄的，再放宽的；
 * 宽块若同时压住两列以上，视为跨列单元格，不参与列的合并，避免把两列粘成一列。
 *
 * @param items 带矩形的文字块
 * @param gapTol 列间空隙容忍
 * @returns 按从左到右排序的列区间
 */
function buildColumns(items: Item[], gapTol: number): Column[] {
  const cols: Column[] = []
  for (const it of items.slice().sort((a, b) => a.r.w - b.r.w)) {
    const hits = cols.filter((c) => overlapOf(c, it.r.x1, it.r.x2) >= -gapTol)
    const strong = hits.filter((c) => overlapOf(c, it.r.x1, it.r.x2) >= SPAN_OVERLAP_RATIO * Math.min(c.x2 - c.x1, it.r.w))
    if (strong.length >= 2) continue
    if (hits.length === 0) {
      cols.push({ x1: it.r.x1, x2: it.r.x2 })
    } else {
      // 只压一列（或贴近多列的空隙里）：并入最近那列
      const c = hits.sort((a, b) => overlapOf(b, it.r.x1, it.r.x2) - overlapOf(a, it.r.x1, it.r.x2))[0]
      c.x1 = Math.min(c.x1, it.r.x1)
      c.x2 = Math.max(c.x2, it.r.x2)
    }
  }
  cols.sort((a, b) => a.x1 - b.x1)
  // 扩张后相邻列可能碰到一起，再合并一遍
  const merged: Column[] = []
  for (const c of cols) {
    const last = merged[merged.length - 1]
    if (last && overlapOf(last, c.x1, c.x2) > 0) {
      last.x2 = Math.max(last.x2, c.x2)
    } else {
      merged.push({ ...c })
    }
  }
  return merged
}

/**
 * 决定一个文字块落在哪一列：压住多列时落到最左那列，否则取重叠最多的列。
 *
 * @param cols 列区间
 * @param it 文字块
 * @returns 列下标
 */
function assignColumn(cols: Column[], it: Item): number {
  const strong: number[] = []
  let best = 0
  let bestOv = -Infinity
  cols.forEach((c, i) => {
    const ov = overlapOf(c, it.r.x1, it.r.x2)
    if (ov >= SPAN_OVERLAP_RATIO * Math.min(c.x2 - c.x1, it.r.w)) strong.push(i)
    if (ov > bestOv) {
      bestOv = ov
      best = i
    }
  })
  return strong.length >= 2 ? strong[0] : best
}

/**
 * 去掉全空的行与列，并补齐成矩形（短行补空串），单元格首尾空白去掉。
 *
 * @param rows 二维数组
 * @returns 规整后的新二维数组；全空返回 []
 * @example normalizeTable([['a', ''], ['', '']]) // [['a']]
 */
export function normalizeTable(rows: string[][]): string[][] {
  const trimmed = rows.map((r) => r.map((c) => c.trim()))
  const width = trimmed.reduce((m, r) => Math.max(m, r.length), 0)
  const full = trimmed.map((r) => r.concat(new Array<string>(width - r.length).fill('')))
  const keepRows = full.filter((r) => r.some((c) => c !== ''))
  if (!keepRows.length) return []
  const keepCols: number[] = []
  for (let c = 0; c < width; c++) if (keepRows.some((r) => r[c] !== '')) keepCols.push(c)
  return keepRows.map((r) => keepCols.map((c) => r[c]))
}

/**
 * OCR 文字块 → 二维表格：先按倾斜角摆正，再按 y 中心聚行、按 x 区间聚列。
 * 同一单元格里有多个块时用空格拼接；跨列的块放进它压住的最左一列。
 *
 * @param blocks OCR 文字块
 * @returns 二维数组（行 × 列）；没有文字返回 []
 * @example blocksToTable(blocks) // [['姓名', '年龄'], ['张三', '20']]
 */
export function blocksToTable(blocks: OcrBlock[]): string[][] {
  const angle = estimateSkew(blocks)
  const items: Item[] = blocks
    .filter((b) => b.text.trim() !== '' && b.box.length >= 4)
    .map((b) => ({ text: b.text.trim(), r: boxRect(angle ? rotateBox(b.box, angle) : b.box) }))
  if (!items.length) return []
  const gapTol = median(items.map((i) => i.r.h)) * COLUMN_GAP_RATIO
  const cols = buildColumns(items, gapTol)
  const rows = clusterRows(items)
  const table = rows.map((row) => {
    const cells = new Array<string>(cols.length).fill('')
    for (const it of row) {
      const c = assignColumn(cols, it)
      cells[c] = cells[c] ? `${cells[c]} ${it.text}` : it.text
    }
    return cells
  })
  return normalizeTable(table)
}

/**
 * 纯文本拆表：每行一行。含制表符时按制表符拆；否则有连续 2 个以上空格时按它拆
 * （保留单元格里的单个空格）；都没有就按任意空白拆。
 *
 * @param text 粘贴的文本（如 OCR 结果、从网页复制的表格）
 * @returns 二维数组；空文本返回 []
 * @example textToTable('姓名 年龄\n张三 20') // [['姓名', '年龄'], ['张三', '20']]
 */
export function textToTable(text: string): string[][] {
  const lines = text.split(/\r\n|\r|\n/)
  const hasTab = lines.some((l) => l.indexOf('\t') >= 0)
  const hasWide = lines.some((l) => /\S {2,}\S/.test(l))
  const splitter = hasTab ? /\t/ : hasWide ? / {2,}/ : /\s+/
  return normalizeTable(lines.map((l) => (l.trim() === '' ? [] : l.trim().split(splitter))))
}

/**
 * 复制到剪贴板的 TSV（粘贴进 WPS / Excel 直接成表）。单元格里的制表符和换行换成空格。
 *
 * @param rows 二维数组
 * @returns TSV 文本
 * @example toTsv([['a', 'b'], ['1', '2']]) // 'a\tb\n1\t2'
 */
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, CELL_SEP_REPLACE)).join('\t')).join('\n')
}

/** 单个单元格的 CSV 转义：含逗号、引号、换行时加引号并把引号翻倍 */
function csvCell(c: string): string {
  return /[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c
}

/**
 * 转 CSV 文本。
 *
 * @param rows 二维数组
 * @param bom 是否加 UTF-8 BOM（下载给 Excel 用时要加，默认 false）
 * @returns CSV 文本，行尾 CRLF
 * @example toCsv([['a,b', 'c']], true) // '﻿"a,b",c'
 */
export function toCsv(rows: string[][], bom = false): string {
  return (bom ? CSV_BOM : '') + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}

/**
 * 改一个单元格，返回新表（不修改入参）。
 *
 * @param rows 二维数组
 * @param r 行
 * @param c 列
 * @param value 新值
 * @returns 新二维数组；下标越界原样返回
 * @example updateCell([['a']], 0, 0, 'b') // [['b']]
 */
export function updateCell(rows: string[][], r: number, c: number, value: string): string[][] {
  if (r < 0 || r >= rows.length || c < 0 || c >= (rows[r]?.length ?? 0)) return rows
  return rows.map((row, i) => (i === r ? row.map((v, j) => (j === c ? value : v)) : row))
}

/**
 * 删除一行。
 *
 * @param rows 二维数组
 * @param r 行下标
 * @returns 新二维数组
 * @example removeRow([['a'], ['b']], 0) // [['b']]
 */
export function removeRow(rows: string[][], r: number): string[][] {
  return rows.filter((_, i) => i !== r)
}

/**
 * 删除一列。
 *
 * @param rows 二维数组
 * @param c 列下标
 * @returns 新二维数组；删到没有列时返回 []
 * @example removeColumn([['a', 'b']], 0) // [['b']]
 */
export function removeColumn(rows: string[][], c: number): string[][] {
  const out = rows.map((r) => r.filter((_, j) => j !== c))
  return out.length && out[0].length ? out : []
}
