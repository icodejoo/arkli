// 对联图：手写（或生成）对联的软提示、布局与 canvas 绘制（DOM 预览与导出图共用同一套尺寸）
import { toneOf } from './tone'

/** 横批字数（传统四字；手写提示用） */
export const BANNER_LEN = 4
/** 手写对联单联最多字数 */
export const CUSTOM_MAX_LEN = 16

/**
 * 对联图尺寸（px，参照春联生成站的移动端版式）。
 * DOM 预览通过 CSS 变量取这些值，导出的 canvas 也按它画，两边保持一致。
 */
export const COUPLET_SPEC = {
  /** 联条宽 */
  colWidth: 59.2,
  /** 联条字号 */
  charSize: 32,
  /** 联条行高倍数 */
  lineHeight: 1.16,
  /** 联条上下内边距 */
  padY: 21.6,
  /** 联条最小高 */
  minHeight: 280,
  /** 联条与福字之间的间距 */
  rowGap: 13.6,
  /** 福字所在中间列宽 */
  midWidth: 96,
  /** 福字块边长 */
  fuSize: 64,
  /** 福字字号 */
  fuFont: 54.4,
  /** 横批牌匾宽 */
  plaqueWidth: 240,
  /** 横批牌匾最小高 */
  plaqueHeight: 52.8,
  /** 横批字号 */
  plaqueFont: 32,
  /** 牌匾与联条之间的间距 */
  gap: 17.6,
  /** 福字（倒贴） */
  fuChar: '福',
} as const
/** 正红底色 */
export const BG_COLOR = '#c1121f'
/** 墨色字 */
export const INK_COLOR = '#1a1a1a'
/** 挽联用白底 */
export const MOURNING_BG_COLOR = '#ffffff'
/** 挽联白底的描边色（白底放在浅色页面上不至于看不出边） */
export const MOURNING_BORDER_COLOR = '#d0d0d0'
/** 书法字体族：在线字体 Ma Shan Zheng 优先，没网时落到系统楷体 */
export const FONT_FAMILY = '"Ma Shan Zheng","KaiTi","STKaiti","Kaiti SC","Noto Serif SC","Songti SC",serif'

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

/** 一个矩形（左上角加宽高） */
export interface Box {
  /** 左上 x */
  x: number
  /** 左上 y */
  y: number
  /** 宽 */
  w: number
  /** 高 */
  h: number
}

/** 一个要画的字 */
export interface GlyphItem {
  /** 字符 */
  ch: string
  /** 中心 x */
  x: number
  /** 中心 y */
  y: number
}

/** 配色主题 */
export interface CoupletTheme {
  /** 底色 */
  bg: string
  /** 字色 */
  ink: string
  /** 描边色；空表示不描边 */
  border: string
}

/** 布局结果 */
export interface CoupletLayout {
  /** 画布宽 */
  width: number
  /** 画布高 */
  height: number
  /** 横批牌匾 */
  plaque: Box
  /** 横批文字及其中心 */
  banner: { text: string; x: number; y: number }
  /** 上联联条（右） */
  upper: Box
  /** 下联联条（左） */
  lower: Box
  /** 福字块中心；挽联不贴福字，为 null */
  fu: { x: number; y: number } | null
  /** 配色 */
  theme: CoupletTheme
  /** 上下联的字，上联在前 */
  items: GlyphItem[]
}

/**
 * 计算对联图布局：上方横批牌匾，下方「下联 | 福 | 上联」三列，上联在右，联条内每字自上而下、整列垂直居中。
 *
 * @param up 上联
 * @param down 下联
 * @param banner 横批
 * @param mourning 是否挽联：白底黑字、不贴福字，默认 false
 * @returns 各块位置、配色与每个字的中心点
 * @example layoutCouplet('春风', '秋雨', '').width
 */
export function layoutCouplet(up: string, down: string, banner: string, mourning = false): CoupletLayout {
  const S = COUPLET_SPEC
  const u = [...up]
  const d = [...down]
  const step = S.charSize * S.lineHeight
  const rows = Math.max(u.length, d.length)
  const colH = Math.max(S.minHeight, S.padY * 2 + rows * step)
  const width = S.colWidth * 2 + S.rowGap * 2 + S.midWidth
  const rowY = S.plaqueHeight + S.gap
  const plaque: Box = { x: (width - S.plaqueWidth) / 2, y: 0, w: S.plaqueWidth, h: S.plaqueHeight }
  const upper: Box = { x: width - S.colWidth, y: rowY, w: S.colWidth, h: colH }
  const lower: Box = { x: 0, y: rowY, w: S.colWidth, h: colH }
  const items: GlyphItem[] = []
  const place = (chars: string[], box: Box): void => {
    const top = box.y + (box.h - chars.length * step) / 2
    chars.forEach((ch, i) => items.push({ ch, x: box.x + box.w / 2, y: top + i * step + step / 2 }))
  }
  place(u, upper)
  place(d, lower)
  return {
    width,
    height: rowY + colH,
    plaque,
    banner: { text: banner, x: width / 2, y: plaque.y + plaque.h / 2 },
    upper,
    lower,
    fu: mourning ? null : { x: width / 2, y: rowY + colH / 2 },
    theme: mourning ? { bg: MOURNING_BG_COLOR, ink: INK_COLOR, border: MOURNING_BORDER_COLOR } : { bg: BG_COLOR, ink: INK_COLOR, border: '' },
    items,
  }
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
  /** 保存状态 */
  save(): void
  /** 恢复状态 */
  restore(): void
  /** 平移原点 */
  translate(x: number, y: number): void
  /** 旋转（弧度） */
  rotate(angle: number): void
  /** 填充矩形 */
  fillRect(x: number, y: number, w: number, h: number): void
  /** 描边矩形 */
  strokeRect(x: number, y: number, w: number, h: number): void
  /** 填充文字 */
  fillText(text: string, x: number, y: number): void
}

/**
 * 把对联画到绘图目标：牌匾和联条（红底，挽联为白底描边）、倒贴的菱形福字（挽联没有）、黑字；画布背景保持透明。
 * 调用方要先设置画布宽高并按需缩放（如 ctx.scale(3, 3) 导出高清图）。
 *
 * @param ctx 绘图目标
 * @param layout layoutCouplet 的结果
 * @example drawCouplet(canvas.getContext('2d')!, layoutCouplet(up, down, banner))
 */
export function drawCouplet(ctx: CoupletCtx, layout: CoupletLayout): void {
  const S = COUPLET_SPEC
  const { bg, ink, border } = layout.theme
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = bg
  for (const b of [layout.plaque, layout.upper, layout.lower]) ctx.fillRect(b.x, b.y, b.w, b.h)
  if (border) {
    ctx.strokeStyle = border
    ctx.lineWidth = 1
    for (const b of [layout.plaque, layout.upper, layout.lower]) ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1)
  }
  // 福字：以块中心为原点，菱形（转 45°）加整体倒转 180°
  if (layout.fu) {
    ctx.save()
    ctx.translate(layout.fu.x, layout.fu.y)
    ctx.rotate(Math.PI)
    ctx.save()
    ctx.rotate(Math.PI / 4)
    ctx.fillRect(-S.fuSize / 2, -S.fuSize / 2, S.fuSize, S.fuSize)
    ctx.restore()
    ctx.fillStyle = ink
    ctx.font = `${S.fuFont}px ${FONT_FAMILY}`
    ctx.fillText(S.fuChar, 0, 0)
    ctx.restore()
  }
  ctx.fillStyle = ink
  if (layout.banner.text) {
    ctx.font = `${S.plaqueFont}px ${FONT_FAMILY}`
    ctx.fillText(layout.banner.text, layout.banner.x, layout.banner.y)
  }
  ctx.font = `${S.charSize}px ${FONT_FAMILY}`
  for (const it of layout.items) ctx.fillText(it.ch, it.x, it.y)
}
