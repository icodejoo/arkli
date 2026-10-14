import type { OcrBlock } from '@/native/ai'
import { boxRect, pointInBox } from '@/tools/_ai/ocrBox'

/** 同一行判定：块中心 y 与行均值之差不超过较小高度的这个比例 */
const LINE_TOLERANCE = 0.5

/** 一行文字 */
export interface OcrLine {
  /** 行文字（块按从左到右拼接） */
  text: string
  /** 组成这一行的块，已按 x 排序 */
  blocks: OcrBlock[]
}

/** 判断字符是否是非 ASCII（中日韩等，拼接时不加空格） */
function isWide(ch: string): boolean {
  return ch.charCodeAt(0) > 0x7f
}

/**
 * 拼接同一行里的相邻文字：两侧都是非 ASCII 字符时直接相连，否则补一个空格。
 *
 * @param texts 从左到右的文字块
 * @returns 拼好的行文字
 * @example joinTexts(['你好', '世界']) // '你好世界'；joinTexts(['a', 'b']) // 'a b'
 */
export function joinTexts(texts: string[]): string {
  let out = ''
  for (const t of texts) {
    if (!t) continue
    if (out && !(isWide(out[out.length - 1]) && isWide(t[0]))) out += ' '
    out += t
  }
  return out
}

/**
 * 把 OCR 文字块按阅读顺序分行：先按中心 y 排，再按「与行均值的纵向偏差」聚行，行内按 x 排。
 *
 * @param blocks OCR 文字块（顺序随意）
 * @returns 从上到下的行
 * @example groupLines([{ text: 'b', box: [20,0,30,0,30,10,20,10], score: 1 }, { text: 'a', box: [0,1,10,1,10,11,0,11], score: 1 }])[0].text // 'a b'
 */
export function groupLines(blocks: OcrBlock[]): OcrLine[] {
  const sorted = blocks
    .filter((b) => b.text.trim() !== '')
    .map((b) => ({ b, r: boxRect(b.box) }))
    .sort((p, q) => p.r.cy - q.r.cy)
  const lines: Array<{ items: typeof sorted; cy: number; h: number }> = []
  for (const it of sorted) {
    const cur = lines[lines.length - 1]
    if (cur && Math.abs(it.r.cy - cur.cy) <= LINE_TOLERANCE * Math.min(it.r.h, cur.h)) {
      cur.items.push(it)
      const n = cur.items.length
      cur.cy += (it.r.cy - cur.cy) / n
      cur.h += (it.r.h - cur.h) / n
    } else {
      lines.push({ items: [it], cy: it.r.cy, h: it.r.h })
    }
  }
  return lines.map((l) => {
    const items = l.items.slice().sort((p, q) => p.r.x1 - q.r.x1)
    return { text: joinTexts(items.map((i) => i.b.text)), blocks: items.map((i) => i.b) }
  })
}

/**
 * 把行拼成全文。
 *
 * @param lines 行
 * @returns 每行一段，换行连接
 * @example linesToText(groupLines(blocks))
 */
export function linesToText(lines: OcrLine[]): string {
  return lines.map((l) => l.text).join('\n')
}

/**
 * 找出点击位置落在哪一行（点在该行任一文字框内）。
 *
 * @param lines 行
 * @param x 点 x（原图坐标）
 * @param y 点 y（原图坐标）
 * @returns 行下标；没点中返回 -1
 * @example lineIndexAt(lines, 5, 5)
 */
export function lineIndexAt(lines: OcrLine[], x: number, y: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].blocks.some((b) => pointInBox(b.box, x, y))) return i
  }
  return -1
}

/**
 * 平均置信度，用于展示。
 *
 * @param blocks 文字块
 * @returns 0~1，没有块时为 0
 * @example averageScore([{ text: 'a', box: [], score: 0.9 }]) // 0.9
 */
export function averageScore(blocks: OcrBlock[]): number {
  if (!blocks.length) return 0
  return blocks.reduce((s, b) => s + b.score, 0) / blocks.length
}
