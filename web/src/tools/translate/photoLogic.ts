// 拍照翻译的纯逻辑：坐标换算、叠层样式、多图结果聚合、进度状态（不依赖 Vue，便于单测）
import type { OcrBlock } from '@/native/ai'

/** 单张图最多处理的文字块数，防止异常大图把翻译队列堵死 */
export const MAX_BLOCKS_PER_IMAGE = 60
/** 一次最多处理的图片数 */
export const MAX_PHOTOS = 9
/** 叠层字号下限（px），再小也看不清 */
export const MIN_FONT_PX = 9
/** 叠层字号占框高的比例上限 */
export const FONT_HEIGHT_RATIO = 0.82
/** 译文按面积估算字号时的行高系数 */
export const LINE_HEIGHT_RATIO = 1.25
/** 原文与译文成对展示的分隔符 */
export const PAIR_SEP = '\n'
/** 块与块、图与图之间的分隔 */
export const BLOCK_SEP = '\n\n'

/** 轴对齐矩形（原图像素或显示像素） */
export interface Rect {
  /** 左 */
  x: number
  /** 上 */
  y: number
  /** 宽 */
  w: number
  /** 高 */
  h: number
}

/** 一个文字块的翻译结果 */
export interface PhotoBlockResult {
  /** 原文 */
  src: string
  /** 译文；失败时为空串 */
  tgt: string
  /** 四点框，原图（OCR 基准）像素 */
  box: number[]
  /** 这块是否翻译失败 */
  failed?: boolean
}

/** 单张图的处理状态 */
export type PhotoStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/** 单张图的结果 */
export interface PhotoItemResult {
  /** 图片名（弹窗分组标题用） */
  name: string
  /** 可显示地址 */
  url: string
  /** OCR 坐标基准宽（未识别前为 0） */
  width: number
  /** OCR 坐标基准高 */
  height: number
  /** 状态 */
  status: PhotoStatus
  /** 失败原因（人话） */
  error?: string
  /** 文字块结果，按阅读顺序 */
  blocks: PhotoBlockResult[]
}

/** 叠层里一个译文块的样式（单位 px，相对图片显示区左上角） */
export interface OverlayStyle {
  /** 左 */
  left: number
  /** 上 */
  top: number
  /** 宽 */
  width: number
  /** 高 */
  height: number
  /** 字号 */
  fontSize: number
}

/**
 * 四点框的外接矩形。
 *
 * @param box [x1,y1,x2,y2,x3,y3,x4,y4]；不足 8 个数时按 0 矩形处理
 * @returns 外接矩形
 * @example boxToRect([10,20,110,20,110,50,10,50]) // { x: 10, y: 20, w: 100, h: 30 }
 */
export function boxToRect(box: number[]): Rect {
  if (box.length < 8) return { x: 0, y: 0, w: 0, h: 0 }
  const xs = [box[0], box[2], box[4], box[6]]
  const ys = [box[1], box[3], box[5], box[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/**
 * 显示缩放比：显示宽 / OCR 基准宽。任一无效时返回 1。
 *
 * @param baseWidth OCR 坐标基准宽
 * @param displayWidth 图片当前显示宽（px）
 * @returns 缩放比
 * @example displayScale(1000, 500) // 0.5
 */
export function displayScale(baseWidth: number, displayWidth: number): number {
  return baseWidth > 0 && displayWidth > 0 ? displayWidth / baseWidth : 1
}

/**
 * 按框高与文字量估算字号：不超过框高比例，也要让整段译文大致放得进框（允许多行），并保底。
 *
 * @param text 译文
 * @param w 框宽（显示 px）
 * @param h 框高（显示 px）
 * @returns 字号 px
 * @example fitFontSize('你好', 100, 20) // 16.4
 */
export function fitFontSize(text: string, w: number, h: number): number {
  const byHeight = h * FONT_HEIGHT_RATIO
  const len = Math.max(Array.from(text).length, 1)
  // 面积法：len 个字、每字约 fs*fs*行高系数，需不超过 w*h
  const byArea = Math.sqrt((w * h) / (len * LINE_HEIGHT_RATIO))
  return Math.max(MIN_FONT_PX, Math.min(byHeight, byArea))
}

/**
 * 文字块到叠层样式：把原图像素框按缩放比换算到显示像素，并算字号。
 *
 * @param box 四点框（OCR 基准像素）
 * @param scale 显示缩放比，见 {@link displayScale}
 * @param text 译文
 * @returns 叠层样式
 * @example overlayStyle([0,0,100,0,100,20,0,20], 0.5, 'Hi') // { left: 0, top: 0, width: 50, height: 10, fontSize: 9 }
 */
export function overlayStyle(box: number[], scale: number, text: string): OverlayStyle {
  const r = boxToRect(box)
  const width = r.w * scale
  const height = r.h * scale
  return { left: r.x * scale, top: r.y * scale, width, height, fontSize: fitFontSize(text, width, height) }
}

/**
 * 把叠层样式转成内联 style 对象（带 px 单位）。
 *
 * @param s 叠层样式
 * @returns 可直接绑 :style 的对象
 */
export function overlayCss(s: OverlayStyle): Record<string, string> {
  return { left: `${s.left}px`, top: `${s.top}px`, width: `${s.width}px`, height: `${s.height}px`, fontSize: `${s.fontSize}px` }
}

/**
 * 筛出要翻译的 OCR 文字块：去空白、丢空文本，并限制张内数量。
 *
 * @param blocks OCR 文字块
 * @param max 上限，默认 {@link MAX_BLOCKS_PER_IMAGE}
 * @returns 有效块（文本已 trim）
 * @example usableBlocks([{ text: ' a ', box: [], score: 1 }]) // [{ text: 'a', box: [], score: 1 }]
 */
export function usableBlocks(blocks: OcrBlock[], max: number = MAX_BLOCKS_PER_IMAGE): OcrBlock[] {
  return blocks
    .map((b) => ({ ...b, text: b.text.trim() }))
    .filter((b) => b.text.length > 0)
    .slice(0, max)
}

/**
 * 单张图的原文/译文成对文本；失败块只列原文。
 *
 * @param item 单张结果
 * @returns 多行文本，无块为空串
 */
export function itemPairsText(item: PhotoItemResult): string {
  return item.blocks.map((b) => (b.tgt ? `${b.src}${PAIR_SEP}${b.tgt}` : b.src)).join(BLOCK_SEP)
}

/**
 * 所有图的整段文本（复制全部用）：多于一张时每张加「第 N 张」标题，没有文字块的图略过。
 *
 * @param items 多图结果
 * @returns 聚合文本；全没有文字块为空串
 * @example aggregateText([{ name: 'a', url: '', width: 1, height: 1, status: 'done', blocks: [{ src: 'Hi', tgt: '你好', box: [] }] }]) // 'Hi\n你好'
 */
export function aggregateText(items: PhotoItemResult[]): string {
  const multi = items.length > 1
  return items
    .map((it, i) => ({ head: multi ? `第 ${i + 1} 张` : '', body: itemPairsText(it) }))
    .filter((s) => s.body)
    .map((s) => (s.head ? `${s.head}${PAIR_SEP}${s.body}` : s.body))
    .join(BLOCK_SEP)
}

/**
 * 单张图的仅译文文本（只复制译文用），每块一行。
 *
 * @param item 单张图结果
 * @returns 译文文本
 */
export function itemTranslated(item: PhotoItemResult): string {
  return item.blocks.filter((b) => b.tgt).map((b) => b.tgt).join(PAIR_SEP)
}

/**
 * 仅译文的聚合文本（复制译文用），每块一行。
 *
 * @param items 多图结果
 * @returns 译文文本
 */
export function aggregateTranslated(items: PhotoItemResult[]): string {
  return items.flatMap((it) => it.blocks.filter((b) => b.tgt).map((b) => b.tgt)).join(PAIR_SEP)
}

/** 多图进度 */
export interface PhotoProgress {
  /** 总张数 */
  total: number
  /** 已结束（成功或失败）张数 */
  finished: number
  /** 其中失败张数 */
  failed: number
  /** 当前处理的是第几张（0 起），没有为 -1 */
  current: number
  /** 是否已被取消 */
  cancelled: boolean
}

/**
 * 初始进度。
 *
 * @param total 总张数
 * @returns 进度
 */
export function initProgress(total: number): PhotoProgress {
  return { total, finished: 0, failed: 0, current: total > 0 ? 0 : -1, cancelled: false }
}

/**
 * 记一张图结束，返回新进度（不改入参）；current 前进到下一张，没有为 -1。
 *
 * @param p 当前进度
 * @param ok 这一张是否成功
 * @returns 新进度
 */
export function finishOne(p: PhotoProgress, ok: boolean): PhotoProgress {
  const finished = Math.min(p.finished + 1, p.total)
  return { ...p, finished, failed: p.failed + (ok ? 0 : 1), current: finished < p.total && !p.cancelled ? finished : -1 }
}

/**
 * 标记取消：current 清空，其余保留。
 *
 * @param p 当前进度
 * @returns 新进度
 */
export function cancelProgress(p: PhotoProgress): PhotoProgress {
  return { ...p, cancelled: true, current: -1 }
}

/**
 * 进度百分比（0~100，取整）。
 *
 * @param p 进度
 * @returns 百分比；总数为 0 时为 0
 */
export function progressPercent(p: PhotoProgress): number {
  return p.total > 0 ? Math.round((p.finished / p.total) * 100) : 0
}

/**
 * 进度文案：处理中「正在处理第 2/5 张」，结束后汇总。
 *
 * @param p 进度
 * @returns 一句话
 * @example progressText(initProgress(3)) // '正在处理第 1/3 张'
 */
export function progressText(p: PhotoProgress): string {
  if (p.cancelled) return `已取消，完成 ${p.finished}/${p.total} 张`
  if (p.current >= 0) return `正在处理第 ${p.current + 1}/${p.total} 张`
  return p.failed > 0 ? `完成，${p.failed} 张失败` : `完成，共 ${p.total} 张`
}
