/** 表情包制作的纯计算：文字换行与自适应字号、文字层命中/拖动、动效帧参数。不碰 DOM，测量函数由调用方注入。 */
import type { Size } from '@/shared/image-calc'

/** 文字宽度测量函数：给定文字与字号（像素），返回宽度（像素） */
export type Measure = (text: string, fontSize: number) => number

/** 经典字幕：基础字号占画布宽度的百分比 */
export const CLASSIC_BASE_PCT = 11
/** 经典字幕：字号下限占画布宽度的百分比 */
export const CLASSIC_MIN_PCT = 4
/** 经典字幕：最多行数 */
export const CLASSIC_MAX_LINES = 3
/** 先尝试缩成单行时，字号最多缩到基础字号的这个比例 */
const SINGLE_LINE_FLOOR = 0.55
/** 行高相对字号的倍数 */
export const LINE_HEIGHT = 1.2
/** 字幕离画布边缘的距离相对字号的倍数 */
const EDGE_MARGIN = 0.35
/** 描边宽度下限（像素） */
const MIN_STROKE = 2
/** 描边宽度相对字号的除数 */
const STROKE_DIV = 8
/** 点选文字层时额外扩出的命中范围（像素） */
export const HIT_SLOP = 10
/** 抖动幅度占画布宽度的比例 */
const SHAKE_AMP_RATIO = 0.015
/** 抖动幅度下限（像素） */
const SHAKE_MIN_AMP = 2
/** 抖动的位移轨迹（单位幅度），首尾相接不突兀 */
const SHAKE_PATH: Array<[number, number]> = [
  [-1, -1],
  [1, 0],
  [0, 1],
  [-1, 1],
  [1, -1],
  [0, -1],
  [1, 1],
  [-1, 0],
]
/** 抖动每帧延迟（厘秒） */
export const SHAKE_DELAY_CS = 6
/** 闪烁：显示阶段延迟（厘秒） */
export const BLINK_ON_CS = 40
/** 闪烁：隐藏阶段延迟（厘秒） */
export const BLINK_OFF_CS = 25
/** 静态单帧的延迟占位（厘秒，不会被写出） */
const STATIC_DELAY_CS = 10

/** 动效预设 */
export type MemePreset = 'none' | 'shake' | 'blink'

/** 字幕位置 */
export type CaptionPosition = 'top' | 'bottom'

/** 自由文字层：位置与字号都用相对值，换输出尺寸不用重算 */
export interface TextLayer {
  /** 唯一编号 */
  id: number
  /** 文字，可含换行 */
  text: string
  /** 中心点 x（占画布宽度 0~1） */
  x: number
  /** 中心点 y（占画布高度 0~1） */
  y: number
  /** 字号占画布宽度的百分比 */
  sizePct: number
  /** 文字颜色 */
  color: string
  /** 描边颜色 */
  strokeColor: string
  /** 描边宽度占字号的百分比（0 表示无描边） */
  strokePct: number
}

/** 一帧动效参数 */
export interface AnimFrame {
  /** 整体水平偏移（像素，输出尺寸下） */
  dx: number
  /** 整体垂直偏移（像素，输出尺寸下） */
  dy: number
  /** 文字是否显示 */
  textVisible: boolean
  /** 本帧延迟（厘秒） */
  delayCs: number
}

/** 字幕的一行：文字与竖直方向中心 y */
export interface CaptionLine {
  /** 文字 */
  text: string
  /** 行中心 y（像素） */
  y: number
}

/** 轴对齐矩形 */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** 英文数字连成一个词，其余每字一个词元，换行时英文单词不被拆开 */
const TOKEN_RE = /[A-Za-z0-9]+|[^A-Za-z0-9]/g

/**
 * 按宽度给文字自动换行：保留手动换行，英文单词尽量不拆，中文逐字，超长单词再按字拆。
 *
 * @param text 原文
 * @param maxWidth 行最大宽度（像素）
 * @param fontSize 字号（像素）
 * @param measure 测量函数
 * @returns 行数组（至少一行）
 * @example wrapText('你好世界', 40, 20, (t, s) => t.length * s) // ['你好', '世界']
 */
export function wrapText(text: string, maxWidth: number, fontSize: number, measure: Measure): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    const tokens: string[] = []
    for (const t of para.match(TOKEN_RE) ?? []) {
      // 超宽的单词按字符拆开
      if (t.length > 1 && measure(t, fontSize) > maxWidth) tokens.push(...t.split(''))
      else tokens.push(t)
    }
    for (const t of tokens) {
      const tryLine = line + t
      if (line === '' || measure(tryLine, fontSize) <= maxWidth) {
        // 行首不放空白
        line = line === '' && t.trim() === '' ? '' : tryLine
      } else {
        out.push(line.trimEnd())
        line = t.trim() === '' ? '' : t
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

/**
 * 经典字幕的自适应：先在 [基础字号×0.55, 基础字号] 内找能放进一行的最大字号；
 * 放不下就允许换行，从大到小找第一个行数不超限的字号；最后兜底用最小字号。
 *
 * @param text 字幕文字
 * @param maxWidth 可用宽度（像素）
 * @param opts baseSize 基础字号；minSize 最小字号；maxLines 最多行数
 * @param measure 测量函数
 * @returns 最终字号与分行结果
 * @example fitCaption('HELLO', 100, { baseSize: 40, minSize: 10, maxLines: 3 }, (t, s) => t.length * s * 0.6)
 */
export function fitCaption(
  text: string,
  maxWidth: number,
  opts: { baseSize: number; minSize: number; maxLines: number },
  measure: Measure,
): { size: number; lines: string[] } {
  const base = Math.max(1, Math.round(opts.baseSize))
  const min = Math.max(1, Math.min(base, Math.round(opts.minSize)))
  const paragraphs = text.split('\n').length
  const singleFloor = Math.max(min, Math.floor(base * SINGLE_LINE_FLOOR))
  for (let size = base; size >= singleFloor; size--) {
    const lines = wrapText(text, maxWidth, size, measure)
    if (lines.length === paragraphs) return { size, lines }
  }
  for (let size = base; size >= min; size--) {
    const lines = wrapText(text, maxWidth, size, measure)
    if (lines.length <= opts.maxLines) return { size, lines }
  }
  return { size: min, lines: wrapText(text, maxWidth, min, measure) }
}

/**
 * 描边宽度：约为字号的 1/8，最少 2 像素。
 *
 * @param fontSize 字号（像素）
 * @returns 描边宽度（像素）
 * @example strokeWidth(40) // 5
 */
export function strokeWidth(fontSize: number): number {
  return Math.max(MIN_STROKE, Math.round(fontSize / STROKE_DIV))
}

/**
 * 经典字幕每行的竖直位置：顶部字幕从上往下排，底部字幕以最后一行贴近下边缘。
 *
 * @param lines 分行文字
 * @param fontSize 字号（像素）
 * @param position top 或 bottom
 * @param canvasH 画布高（像素）
 * @returns 每行文字与中心 y
 * @example captionLines(['A'], 20, 'top', 100) // [{ text: 'A', y: 19 }]
 */
export function captionLines(lines: string[], fontSize: number, position: CaptionPosition, canvasH: number): CaptionLine[] {
  const lh = fontSize * LINE_HEIGHT
  const margin = fontSize * EDGE_MARGIN
  const start = position === 'top' ? margin + lh / 2 : canvasH - margin - lh / 2 - (lines.length - 1) * lh
  return lines.map((text, i) => ({ text, y: Math.round(start + i * lh) }))
}

/**
 * 自由文字层的字号（像素）。
 *
 * @param layer 文字层
 * @param canvasW 画布宽（像素）
 * @returns 字号，至少 1
 * @example layerFontPx({ sizePct: 10 } as TextLayer, 400) // 40
 */
export function layerFontPx(layer: Pick<TextLayer, 'sizePct'>, canvasW: number): number {
  return Math.max(1, Math.round((canvasW * layer.sizePct) / 100))
}

/**
 * 文字层在画布上占的矩形（含多行），不含描边。
 *
 * @param layer 文字层
 * @param canvasW 画布宽（像素）
 * @param canvasH 画布高（像素）
 * @param measure 测量函数
 * @returns 矩形（像素）
 */
export function layerBox(layer: TextLayer, canvasW: number, canvasH: number, measure: Measure): Box {
  const size = layerFontPx(layer, canvasW)
  const lines = layer.text.split('\n')
  const width = Math.max(...lines.map((l) => measure(l, size)), 0)
  const height = lines.length * size * LINE_HEIGHT
  return { left: layer.x * canvasW - width / 2, top: layer.y * canvasH - height / 2, width, height }
}

/**
 * 点选：返回包含该点的最上层文字层下标（数组越靠后越在上面），没有返回 -1。
 *
 * @param layers 文字层
 * @param px 点 x（画布像素）
 * @param py 点 y（画布像素）
 * @param canvasW 画布宽
 * @param canvasH 画布高
 * @param measure 测量函数
 * @returns 下标或 -1
 */
export function hitLayer(layers: TextLayer[], px: number, py: number, canvasW: number, canvasH: number, measure: Measure): number {
  for (let i = layers.length - 1; i >= 0; i--) {
    const b = layerBox(layers[i], canvasW, canvasH, measure)
    if (px >= b.left - HIT_SLOP && px <= b.left + b.width + HIT_SLOP && py >= b.top - HIT_SLOP && py <= b.top + b.height + HIT_SLOP) return i
  }
  return -1
}

/**
 * 拖动后的新中心点（相对值），限制在画布内。
 *
 * @param layer 文字层
 * @param dxPx 水平位移（画布像素）
 * @param dyPx 垂直位移（画布像素）
 * @param canvasW 画布宽
 * @param canvasH 画布高
 * @returns 新的 x、y（0~1）
 * @example moveLayer({ x: 0.5, y: 0.5 } as TextLayer, 50, 0, 100, 100) // { x: 1, y: 0.5 }
 */
export function moveLayer(layer: Pick<TextLayer, 'x' | 'y'>, dxPx: number, dyPx: number, canvasW: number, canvasH: number): { x: number; y: number } {
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
  return { x: clamp01(layer.x + dxPx / canvasW), y: clamp01(layer.y + dyPx / canvasH) }
}

/**
 * 抖动动效的单帧位移幅度（像素）。
 *
 * @param width 输出画布宽
 * @returns 幅度，至少 2 像素
 */
export function shakeAmplitude(width: number): number {
  return Math.max(SHAKE_MIN_AMP, Math.round(width * SHAKE_AMP_RATIO))
}

/**
 * 抖动时背景要放大的倍数，保证位移后画布边缘不露底。
 *
 * @param width 画布宽
 * @param height 画布高
 * @param amp 位移幅度（像素）
 * @returns 缩放倍数（≥1）
 * @example shakeScale(100, 100, 2) // 1.04
 */
export function shakeScale(width: number, height: number, amp: number): number {
  return 1 + Math.max((2 * amp) / width, (2 * amp) / height)
}

/**
 * 动效各帧的参数。none 只有一帧；shake 按固定轨迹每帧位移，文字始终显示；blink 文字显隐交替。
 *
 * @param preset 预设
 * @param width 输出画布宽（决定抖动幅度）
 * @returns 帧参数数组（至少一帧）
 * @example animFrames('blink', 300).map((f) => f.textVisible) // [true, false]
 */
export function animFrames(preset: MemePreset, width: number): AnimFrame[] {
  if (preset === 'shake') {
    const amp = shakeAmplitude(width)
    return SHAKE_PATH.map(([x, y]) => ({ dx: x * amp, dy: y * amp, textVisible: true, delayCs: SHAKE_DELAY_CS }))
  }
  if (preset === 'blink') {
    return [
      { dx: 0, dy: 0, textVisible: true, delayCs: BLINK_ON_CS },
      { dx: 0, dy: 0, textVisible: false, delayCs: BLINK_OFF_CS },
    ]
  }
  return [{ dx: 0, dy: 0, textVisible: true, delayCs: STATIC_DELAY_CS }]
}

/**
 * 按比例和长边算出纯色底的尺寸。
 *
 * @param ratioW 比例的宽
 * @param ratioH 比例的高
 * @param edge 长边像素
 * @returns 尺寸
 * @example ratioSize(16, 9, 480) // { width: 480, height: 270 }
 */
export function ratioSize(ratioW: number, ratioH: number, edge: number): Size {
  if (ratioW <= 0 || ratioH <= 0) return { width: edge, height: edge }
  const k = edge / Math.max(ratioW, ratioH)
  return { width: Math.max(1, Math.round(ratioW * k)), height: Math.max(1, Math.round(ratioH * k)) }
}
