/** 表情包画布绘制：底图、经典上下字、自由文字层、动效偏移。只依赖 2D 上下文，预览与导出共用。 */
import {
  CLASSIC_MAX_LINES,
  CLASSIC_MIN_PCT,
  captionLines,
  fitCaption,
  layerBox,
  layerFontPx,
  LINE_HEIGHT,
  shakeAmplitude,
  shakeScale,
  strokeWidth,
  type AnimFrame,
  type Measure,
  type TextLayer,
} from './logic'

/** 字体族：先 Impact（英文表情包经典），再回落到中文系统字体 */
export const FONT_FAMILY = 'Impact, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif'
/** 经典字幕文字色 */
const CLASSIC_FILL = '#ffffff'
/** 经典字幕描边色 */
const CLASSIC_STROKE = '#000000'
/** 字幕可用宽度占画布宽度的比例 */
const CAPTION_WIDTH_RATIO = 0.94
/** 选中框外扩像素 */
const SELECT_PAD = 4
/** 选中框颜色 */
const SELECT_COLOR = '#1989fa'
/** 选中框虚线样式 */
const SELECT_DASH = [6, 4]

/** 一幅表情包的内容 */
export interface MemeScene {
  /** 底图（已缩到工作尺寸）；纯色底时为 null */
  base: HTMLCanvasElement | null
  /** 底色（纯色底，或底图透明处） */
  bgColor: string
  /** 顶部字幕 */
  top: string
  /** 底部字幕 */
  bottom: string
  /** 经典字幕基础字号占画布宽度的百分比 */
  classicSizePct: number
  /** 自由文字层（后面的盖在上面） */
  layers: TextLayer[]
}

/**
 * 字体声明串。
 *
 * @param size 字号（像素）
 * @returns 可赋给 ctx.font 的字符串
 */
export function fontOf(size: number): string {
  return `bold ${size}px ${FONT_FAMILY}`
}

/**
 * 基于 2D 上下文生成测量函数。
 *
 * @param ctx 2D 上下文
 * @returns 测量函数（会改动 ctx.font）
 */
export function makeMeasure(ctx: CanvasRenderingContext2D): Measure {
  return (text, size) => {
    ctx.font = fontOf(size)
    return ctx.measureText(text).width
  }
}

/** 画一行带描边的居中文字 */
function strokedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, fill: string, stroke: string, lineWidth: number): void {
  ctx.font = fontOf(size)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  if (lineWidth > 0) {
    ctx.lineWidth = lineWidth
    ctx.strokeStyle = stroke
    ctx.strokeText(text, x, y)
  }
  ctx.fillStyle = fill
  ctx.fillText(text, x, y)
}

/** 画经典上/下字幕 */
function drawClassic(ctx: CanvasRenderingContext2D, w: number, h: number, text: string, position: 'top' | 'bottom', pct: number, measure: Measure): void {
  if (!text.trim()) return
  const base = Math.max(1, Math.round((w * pct) / 100))
  const min = Math.min(base, Math.max(1, Math.round((w * CLASSIC_MIN_PCT) / 100)))
  const fit = fitCaption(text, w * CAPTION_WIDTH_RATIO, { baseSize: base, minSize: min, maxLines: CLASSIC_MAX_LINES }, measure)
  for (const line of captionLines(fit.lines, fit.size, position, h)) {
    strokedText(ctx, line.text, w / 2, line.y, fit.size, CLASSIC_FILL, CLASSIC_STROKE, strokeWidth(fit.size))
  }
}

/** 画一个自由文字层（多行按行高排布） */
function drawLayer(ctx: CanvasRenderingContext2D, w: number, h: number, layer: TextLayer): void {
  const size = layerFontPx(layer, w)
  const lines = layer.text.split('\n')
  const lh = size * LINE_HEIGHT
  const top = layer.y * h - (lines.length * lh) / 2 + lh / 2
  lines.forEach((t, i) => strokedText(ctx, t, layer.x * w, top + i * lh, size, layer.color, layer.strokeColor, (size * layer.strokePct) / 100))
}

/**
 * 把一幅表情包画到 ctx 上（画布尺寸 w×h）。
 *
 * @param ctx 目标 2D 上下文
 * @param w 画布宽
 * @param h 画布高
 * @param scene 内容
 * @param frame 动效帧参数，缺省为静态
 * @param selectedId 要画选中框的文字层 id（仅预览用），缺省不画
 * @example drawMeme(canvas.getContext('2d')!, canvas.width, canvas.height, scene)
 */
export function drawMeme(ctx: CanvasRenderingContext2D, w: number, h: number, scene: MemeScene, frame?: AnimFrame, selectedId?: number | null): void {
  const measure = makeMeasure(ctx)
  ctx.save()
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = scene.bgColor
  ctx.fillRect(0, 0, w, h)
  // 抖动：整幅画面放大一点再平移，边缘不露底
  if (frame && (frame.dx !== 0 || frame.dy !== 0)) {
    const s = shakeScale(w, h, shakeAmplitude(w))
    ctx.translate(w / 2 + frame.dx, h / 2 + frame.dy)
    ctx.scale(s, s)
    ctx.translate(-w / 2, -h / 2)
  }
  if (scene.base) ctx.drawImage(scene.base, 0, 0, w, h)
  if (!frame || frame.textVisible) {
    drawClassic(ctx, w, h, scene.top, 'top', scene.classicSizePct, measure)
    drawClassic(ctx, w, h, scene.bottom, 'bottom', scene.classicSizePct, measure)
    for (const layer of scene.layers) drawLayer(ctx, w, h, layer)
  }
  ctx.restore()
  if (selectedId != null) {
    const layer = scene.layers.find((l) => l.id === selectedId)
    if (layer) {
      const b = layerBox(layer, w, h, measure)
      ctx.save()
      ctx.strokeStyle = SELECT_COLOR
      ctx.lineWidth = 2
      ctx.setLineDash(SELECT_DASH)
      ctx.strokeRect(b.left - SELECT_PAD, b.top - SELECT_PAD, b.width + SELECT_PAD * 2, b.height + SELECT_PAD * 2)
      ctx.restore()
    }
  }
}
