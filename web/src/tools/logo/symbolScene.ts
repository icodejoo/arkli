// AI 符号版式：把单色符号放进 App 自己画的容器（圆环徽章 / 实心圆 / 圆角方块 / 横排），再排品牌名与标语。纯函数，输出与模板共用的 Scene。

import { getFont } from './fonts'
import { applyOverrides, getPalette } from './palettes'
import { fitFontSize, safeNum } from './scene'
import { FONT_SCALE_MAX, FONT_SCALE_MIN, SPACING_MAX, SPACING_MIN, type LogoParams, type Palette, type Scene, type SceneItem, type SymbolLayoutId } from './types'

/** 符号占容器内圈直径（或方块边长）的比例（桌面 spike 的取值） */
export const SYMBOL_RATIO = 0.58
/** 默认品牌名 */
const DEFAULT_NAME = '品牌名'
/** 竖排画布边长 */
const SIDE = 600
/** 横排画布宽 */
const LOCKUP_W = 900
/** 横排画布高 */
const LOCKUP_H = 420
/** 圆环外圈半径（与 badge-circle 同比例 255:232，按竖排缩放） */
const RING_OUTER_R = 190
/** 圆环内圆半径 */
const RING_INNER_R = 173
/** 圆角方块边长（竖排） */
const SQUARE_SIDE = 344
/** 圆角方块圆角（竖排） */
const SQUARE_RX = 44
/** 横排容器边长 */
const LOCKUP_BOX = 260
/** 横排容器圆角 */
const LOCKUP_RX = 36
/** 容器与文字的间距（竖排） */
const GAP_BOX_TEXT = 30
/** 品牌名与标语的间距 */
const GAP_NAME_SLOGAN = 12
/** 横排容器与文字的间距 */
const GAP_LOCKUP = 50
/** 竖排品牌名基准字号 */
const NAME_SIZE = 48
/** 竖排标语基准字号 */
const SLOGAN_SIZE = 22
/** 横排品牌名基准字号 */
const LOCKUP_NAME_SIZE = 64
/** 横排标语基准字号 */
const LOCKUP_SLOGAN_SIZE = 26
/** 竖排文字最大宽度 */
const TEXT_MAX_W = 480
/** 横排文字最大宽度 */
const LOCKUP_TEXT_MAX_W = 420
/** 标语额外字距（em） */
const SLOGAN_SPACING_EM = 0.08
/** 文字基线相对字号的偏移 */
const BASELINE = 0.85
/** 浅色填充的透明度十六进制 */
const TINT = '14'
/** 描边宽：外圈 */
const SW_OUTER = 2
/** 描边宽：容器 */
const SW_BOX = 3
/** 常规字重 */
const WEIGHT_REGULAR = 400

/** 版式信息 */
export interface SymbolLayoutInfo {
  /** 版式 id */
  id: SymbolLayoutId
  /** 中文名 */
  name: string
  /** 画布宽 */
  w: number
  /** 画布高 */
  h: number
}

/** AI 符号可选版式（不并进 TEMPLATES，免得影响模板方案与关键词排版） */
export const SYMBOL_LAYOUTS: readonly SymbolLayoutInfo[] = [
  { id: 'ai-ring', name: '圆环徽章', w: SIDE, h: SIDE },
  { id: 'ai-solid', name: '实心圆', w: SIDE, h: SIDE },
  { id: 'ai-square', name: '圆角方块', w: SIDE, h: SIDE },
  { id: 'ai-lockup', name: '横排', w: LOCKUP_W, h: LOCKUP_H },
]

/** 夹紧到区间，非数字回到 fallback */
function clampNum(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

/** 符号图元：居中放进以 (cx, cy) 为中心、边长 box 的区域，占 SYMBOL_RATIO */
function symbolItems(p: LogoParams, cx: number, cy: number, box: number, color: string): SceneItem[] {
  const sym = p.symbol
  if (!sym || !sym.paths.length) return []
  const size = safeNum(box * SYMBOL_RATIO)
  return [{ k: 'symbol', paths: sym.paths, vb: sym.vb, x: safeNum(cx - size / 2), y: safeNum(cy - size / 2), size, color }]
}

/** 容器图元：返回要画的图元与符号颜色 */
function containerItems(layout: SymbolLayoutId, pal: Palette, cx: number, cy: number): { items: SceneItem[]; box: number; color: string } {
  const tint = `${pal.primary}${TINT}`
  if (layout === 'ai-solid') {
    return {
      items: [
        { k: 'circle', cx, cy, r: RING_OUTER_R, stroke: pal.secondary, sw: SW_OUTER },
        { k: 'circle', cx, cy, r: RING_INNER_R, fill: pal.primary },
      ],
      box: RING_INNER_R * 2,
      color: pal.bg,
    }
  }
  if (layout === 'ai-square' || layout === 'ai-lockup') {
    const side = layout === 'ai-lockup' ? LOCKUP_BOX : SQUARE_SIDE
    const rx = layout === 'ai-lockup' ? LOCKUP_RX : SQUARE_RX
    return {
      items: [{ k: 'rect', x: safeNum(cx - side / 2), y: safeNum(cy - side / 2), w: side, h: side, rx, fill: tint, stroke: pal.primary, sw: SW_BOX }],
      box: side,
      color: pal.primary,
    }
  }
  return {
    items: [
      { k: 'circle', cx, cy, r: RING_OUTER_R, stroke: pal.secondary, sw: SW_OUTER },
      { k: 'circle', cx, cy, r: RING_INNER_R, fill: tint, stroke: pal.primary, sw: SW_BOX },
    ],
    box: RING_INNER_R * 2,
    color: pal.primary,
  }
}

/**
 * 参数（带 symbol）→ AI 符号版式的场景。符号占容器 58%；没有 symbol 时只画容器与文字。
 *
 * @param p logo 参数，`p.symbol.layout` 决定版式
 * @returns 场景（与模板共用同一套图元，SVG 与 Canvas 两个后端都能画）
 * @example buildSymbolScene({ ...params, symbol: { layout: 'ai-ring', vb: 512, paths } })
 */
export function buildSymbolScene(p: LogoParams): Scene {
  const layout = p.symbol?.layout ?? 'ai-ring'
  const info = SYMBOL_LAYOUTS.find((l) => l.id === layout) ?? SYMBOL_LAYOUTS[0]
  const pal = applyOverrides(getPalette(p.palette), p.primaryOverride, p.invert)
  const font = getFont(p.font)
  const name = p.name?.trim() || DEFAULT_NAME
  const slogan = p.slogan?.trim() ?? ''
  const scale = clampNum(p.fontScale, FONT_SCALE_MIN, FONT_SCALE_MAX, 1)
  const spacing = clampNum(p.spacing, SPACING_MIN, SPACING_MAX, 0)
  const lockup = info.id === 'ai-lockup'
  const nameFit = fitFontSize(name, lockup ? LOCKUP_NAME_SIZE : NAME_SIZE, scale, spacing, font.weight, lockup ? LOCKUP_TEXT_MAX_W : TEXT_MAX_W)
  const sloganFit = slogan
    ? fitFontSize(slogan, lockup ? LOCKUP_SLOGAN_SIZE : SLOGAN_SIZE, scale, spacing + SLOGAN_SPACING_EM, WEIGHT_REGULAR, lockup ? LOCKUP_TEXT_MAX_W : TEXT_MAX_W)
    : null
  const textH = nameFit.size + (sloganFit ? GAP_NAME_SLOGAN + sloganFit.size : 0)
  const items: SceneItem[] = []

  if (lockup) {
    const textW = Math.max(nameFit.width, sloganFit?.width ?? 0)
    const startX = (info.w - (LOCKUP_BOX + GAP_LOCKUP + textW)) / 2
    const cx = startX + LOCKUP_BOX / 2
    const cy = info.h / 2
    const c = containerItems(info.id, pal, safeNum(cx), cy)
    items.push(...c.items, ...symbolItems(p, cx, cy, c.box, c.color))
    const tx = safeNum(startX + LOCKUP_BOX + GAP_LOCKUP)
    let y = cy - textH / 2
    items.push({ k: 'text', text: name, x: tx, y: safeNum(y + nameFit.size * BASELINE), size: nameFit.size, weight: font.weight, family: font.family, color: pal.text, anchor: 'start', spacing: nameFit.spacingPx, italic: font.italic })
    if (sloganFit) {
      y += nameFit.size + GAP_NAME_SLOGAN
      items.push({ k: 'text', text: slogan, x: tx, y: safeNum(y + sloganFit.size * BASELINE), size: sloganFit.size, weight: WEIGHT_REGULAR, family: font.family, color: pal.secondary, anchor: 'start', spacing: sloganFit.spacingPx, italic: font.italic })
    }
  } else {
    const boxH = info.id === 'ai-square' ? SQUARE_SIDE : RING_OUTER_R * 2
    const totalH = boxH + GAP_BOX_TEXT + textH
    const top = (info.h - totalH) / 2
    const cx = info.w / 2
    const cy = top + boxH / 2
    const c = containerItems(info.id, pal, cx, safeNum(cy))
    items.push(...c.items, ...symbolItems(p, cx, cy, c.box, c.color))
    let y = top + boxH + GAP_BOX_TEXT
    items.push({ k: 'text', text: name, x: cx, y: safeNum(y + nameFit.size * BASELINE), size: nameFit.size, weight: font.weight, family: font.family, color: pal.text, anchor: 'middle', spacing: nameFit.spacingPx, italic: font.italic })
    if (sloganFit) {
      y += nameFit.size + GAP_NAME_SLOGAN
      items.push({ k: 'text', text: slogan, x: cx, y: safeNum(y + sloganFit.size * BASELINE), size: sloganFit.size, weight: WEIGHT_REGULAR, family: font.family, color: pal.secondary, anchor: 'middle', spacing: sloganFit.spacingPx, italic: font.italic })
    }
  }
  return { w: info.w, h: info.h, bg: pal.bg, items }
}
