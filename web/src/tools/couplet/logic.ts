// 对联画布：手写（或生成）对联的软提示、竖排布局与绘制
import { toneOf } from './tone'

/** 横批字数（传统四字；手写提示用） */
export const BANNER_LEN = 4
/** 手写对联单联最多字数 */
export const CUSTOM_MAX_LEN = 16

/** 手写对联画布参数 */
const CANVAS_MARGIN = 40
/** 单列宽度 */
const COL_WIDTH = 110
/** 两列之间的空白 */
const COL_GAP = 170
/** 对联单字字号 */
const CHAR_SIZE = 64
/** 竖排字间距 */
const CHAR_GAP = 10
/** 横批字号 */
const BANNER_SIZE = 52
/** 横批区高度 */
const BANNER_AREA = 110
/** 红底色 */
export const BG_COLOR = '#c8102e'
/** 金字色 */
export const GOLD_COLOR = '#ffd54a'
/** 书法字体族 */
const FONT_FAMILY = '"KaiTi","STKaiti","Kaiti SC","Noto Serif SC","Songti SC",serif'

/**
 * 手写对联的软提示（不拦截）：长度不等、过长、收尾平仄。
 *
 * @param up 上联
 * @param down 下联
 * @param banner 横批
 * @returns 提示文案列表；空表示没问题
 * @example customWarnings('春风送暖', '瑞雪兆丰', '万象更新') // []
 */
export function customWarnings(up: string, down: string, banner: string): string[] {
  const w: string[] = []
  const a = [...up]
  const b = [...down]
  if (a.length !== b.length) w.push('上下联字数不一致')
  if (a.length > CUSTOM_MAX_LEN || b.length > CUSTOM_MAX_LEN) w.push(`单联最多 ${CUSTOM_MAX_LEN} 字`)
  if (banner && [...banner].length !== BANNER_LEN) w.push(`横批一般是 ${BANNER_LEN} 字`)
  const t1 = toneOf(a[a.length - 1] ?? '')
  const t2 = toneOf(b[b.length - 1] ?? '')
  if (t1 === '平') w.push('传统上上联以仄声收尾')
  if (t2 === '仄') w.push('传统上下联以平声收尾')
  return w
}

/** 一个要画的字 */
export interface GlyphItem {
  /** 字符 */
  ch: string
  /** 中心 x */
  x: number
  /** 中心 y */
  y: number
  /** 字号 */
  size: number
}

/** 布局结果 */
export interface CoupletLayout {
  /** 画布宽 */
  width: number
  /** 画布高 */
  height: number
  /** 所有字，含横批、上联（右）、下联（左） */
  items: GlyphItem[]
}

/**
 * 计算手写对联的竖排布局：上联在右，下联在左，横批在顶部居中从左到右。
 *
 * @param up 上联
 * @param down 下联
 * @param banner 横批
 * @returns 画布尺寸与每个字的位置
 * @example layoutCouplet('春风', '秋雨', '').width
 */
export function layoutCouplet(up: string, down: string, banner: string): CoupletLayout {
  const u = [...up]
  const d = [...down]
  const b = [...banner]
  const rows = Math.max(u.length, d.length, 1)
  const width = CANVAS_MARGIN * 2 + COL_WIDTH * 2 + COL_GAP
  const colTop = CANVAS_MARGIN + (b.length ? BANNER_AREA : 0)
  const height = colTop + rows * (CHAR_SIZE + CHAR_GAP) + CANVAS_MARGIN
  const items: GlyphItem[] = []
  const bStep = BANNER_SIZE * 1.2
  b.forEach((ch, i) => {
    items.push({ ch, x: width / 2 + (i - (b.length - 1) / 2) * bStep, y: CANVAS_MARGIN + BANNER_SIZE / 2, size: BANNER_SIZE })
  })
  const colChars = (chars: string[], x: number): void => {
    chars.forEach((ch, i) => items.push({ ch, x, y: colTop + i * (CHAR_SIZE + CHAR_GAP) + CHAR_SIZE / 2, size: CHAR_SIZE }))
  }
  colChars(u, width - CANVAS_MARGIN - COL_WIDTH / 2)
  colChars(d, CANVAS_MARGIN + COL_WIDTH / 2)
  return { width, height, items }
}

/** 最小绘图接口（CanvasRenderingContext2D 满足），便于测试注入 */
export interface CoupletCtx {
  /** 填充色 */
  fillStyle: string | CanvasGradient | CanvasPattern
  /** 描边色 */
  strokeStyle: string | CanvasGradient | CanvasPattern
  /** 线宽 */
  lineWidth: number
  /** 字体 */
  font: string
  /** 水平对齐 */
  textAlign: CanvasTextAlign
  /** 垂直基线 */
  textBaseline: CanvasTextBaseline
  /** 填充矩形 */
  fillRect(x: number, y: number, w: number, h: number): void
  /** 描边矩形 */
  strokeRect(x: number, y: number, w: number, h: number): void
  /** 填充文字 */
  fillText(text: string, x: number, y: number): void
}

/**
 * 把对联画到绘图目标：红底、金边、金字。调用方要先按 layout 设置画布宽高。
 *
 * @param ctx 绘图目标
 * @param layout layoutCouplet 的结果
 * @example drawCouplet(canvas.getContext('2d')!, layoutCouplet(up, down, banner))
 */
export function drawCouplet(ctx: CoupletCtx, layout: CoupletLayout): void {
  ctx.fillStyle = BG_COLOR
  ctx.fillRect(0, 0, layout.width, layout.height)
  ctx.strokeStyle = GOLD_COLOR
  ctx.lineWidth = 4
  ctx.strokeRect(12, 12, layout.width - 24, layout.height - 24)
  ctx.fillStyle = GOLD_COLOR
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const it of layout.items) {
    ctx.font = `bold ${it.size}px ${FONT_FAMILY}`
    ctx.fillText(it.ch, it.x, it.y)
  }
}
