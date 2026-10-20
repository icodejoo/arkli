// 纯函数 Logo 场景生成器：负责将 LogoParams 转换为无状态可渲染的 Scene 模型

import type {
  CircleItem,
  IconItem,
  LogoParams,
  PathItem,
  RectItem,
  Scene,
  SceneItem,
  TemplateId,
  TextItem,
} from './types'
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  SPACING_MAX,
  SPACING_MIN,
} from './types'
import { applyOverrides, getPalette } from './palettes'
import { estimateTextWidth, getFont } from './fonts'
import { ICON_DATA } from './assets/iconData'

/** 正方形画布尺寸 */
const CANVAS_SIZE_SQUARE = 600
/** 横版画布宽度 */
const CANVAS_WIDTH_HORIZONTAL = 900
/** 横版画布高度 */
const CANVAS_HEIGHT_HORIZONTAL = 420
/** 正方形画布中心坐标 */
const CANVAS_CENTER_SQUARE = 300
/** 横版画布水平中心坐标 */
const CANVAS_CENTER_H_X = 450
/** 横版画布垂直中心坐标 */
const CANVAS_CENTER_H_Y = 210

/** 默认兜底品牌名 */
const DEFAULT_BRAND_NAME = '品牌名'
/** 空字符串 */
const EMPTY_STRING = ''

/** 矩形图元类型标识 */
const ITEM_K_RECT = 'rect'
/** 圆形图元类型标识 */
const ITEM_K_CIRCLE = 'circle'
/** 路径图元类型标识 */
const ITEM_K_PATH = 'path'
/** 图标图元类型标识 */
const ITEM_K_ICON = 'icon'
/** 文本图元类型标识 */
const ITEM_K_TEXT = 'text'

/** 居中对齐锚点 */
const ANCHOR_MIDDLE = 'middle'

/** 细描边宽度 */
const STROKE_WIDTH_THIN = 1.5
/** 默认通用描边宽度 */
const STROKE_WIDTH_DEFAULT = 2
/** 容器边框描边宽度 */
const STROKE_WIDTH_CONTAINER = 3
/** 容器浅色填充十六进制透明度 */
const FILL_TINT_ALPHA = '14'

/** 文本基线估算偏移比例 */
const BASELINE_OFFSET_RATIO = 0.85
/** 单行文本垂直居中基线偏移比例 */
const CENTER_BASELINE_OFFSET_RATIO = 0.35
/** 常规字重 */
const WEIGHT_NORMAL = 400
/** 标语默认额外字符间距 */
const DEFAULT_SLOGAN_SPACING_EM = 0.08
/** 双线标语额外字符间距 */
const EXTRA_SLOGAN_SPACING_EM = 0.14

/** 徽章圆形模板标识 */
const TEMPLATE_BADGE_CIRCLE = 'badge-circle'
/** 方形圆角模板标识 */
const TEMPLATE_SQUARE_ROUND = 'square-round'
/** 盾形徽章模板标识 */
const TEMPLATE_SHIELD = 'shield'
/** 水平横排模板标识 */
const TEMPLATE_H_LOCKUP = 'h-lockup'
/** 上下堆叠居中模板标识 */
const TEMPLATE_STACK = 'stack'
/** 首字印记模板标识 */
const TEMPLATE_MONOGRAM = 'monogram'
/** 全圆胶囊模板标识 */
const TEMPLATE_PILL = 'pill'
/** 纯文字标模板标识 */
const TEMPLATE_WORDMARK = 'wordmark'
/** 双线标语模板标识 */
const TEMPLATE_TAGLINE_STACK = 'tagline-stack'
/** 双圈印章模板标识 */
const TEMPLATE_RING_SEAL = 'ring-seal'

/**
 * 模板配置信息接口定义
 */
export interface TemplateInfo {
  /** 模板唯一标识 */
  id: TemplateId
  /** 模板中文名称 */
  name: string
  /** 画布宽度 */
  w: number
  /** 画布高度 */
  h: number
  /** 模板特征描述 */
  desc: string
}

/**
 * 支持的 10 套 Logo 布局模板列表
 */
export const TEMPLATES: TemplateInfo[] = [
  {
    id: TEMPLATE_BADGE_CIRCLE,
    name: '圆形徽章',
    w: CANVAS_SIZE_SQUARE,
    h: CANVAS_SIZE_SQUARE,
    desc: '整圆底+图标在上品牌名在下，圆外描边环',
  },
  {
    id: TEMPLATE_SQUARE_ROUND,
    name: '方形圆角',
    w: CANVAS_SIZE_SQUARE,
    h: CANVAS_SIZE_SQUARE,
    desc: '圆角方块底色，内含图标与名字',
  },
  {
    id: TEMPLATE_SHIELD,
    name: '盾形徽章',
    w: CANVAS_SIZE_SQUARE,
    h: CANVAS_SIZE_SQUARE,
    desc: '主色实心盾牌内嵌细辅色内线，反白图标与名字',
  },
  {
    id: TEMPLATE_H_LOCKUP,
    name: '水平横排',
    w: CANVAS_WIDTH_HORIZONTAL,
    h: CANVAS_HEIGHT_HORIZONTAL,
    desc: '左图标右文字，标语在名字下，画布宽>高',
  },
  {
    id: TEMPLATE_STACK,
    name: '上下居中',
    w: CANVAS_SIZE_SQUARE,
    h: CANVAS_SIZE_SQUARE,
    desc: '上图下字，居中',
  },
  {
    id: TEMPLATE_MONOGRAM,
    name: '首字印记',
    w: CANVAS_SIZE_SQUARE,
    h: CANVAS_SIZE_SQUARE,
    desc: '大号首字居中放在大方块里，品牌名与标语放下面整体居中',
  },
  {
    id: TEMPLATE_PILL,
    name: '圆角胶囊',
    w: CANVAS_WIDTH_HORIZONTAL,
    h: CANVAS_HEIGHT_HORIZONTAL,
    desc: '圆角全圆的横向胶囊撑满约80%宽，左图标右名字',
  },
  {
    id: TEMPLATE_WORDMARK,
    name: '纯文字标',
    w: CANVAS_WIDTH_HORIZONTAL,
    h: CANVAS_HEIGHT_HORIZONTAL,
    desc: '大号品牌名约占宽70%，下方粗短横线与标语装饰',
  },
  {
    id: TEMPLATE_TAGLINE_STACK,
    name: '双线标语',
    w: CANVAS_SIZE_SQUARE,
    h: CANVAS_SIZE_SQUARE,
    desc: '带标语双行：图标+品牌名+标语，标语小字加字距，上下各一条细线',
  },
  {
    id: TEMPLATE_RING_SEAL,
    name: '双圈印章',
    w: CANVAS_SIZE_SQUARE,
    h: CANVAS_SIZE_SQUARE,
    desc: '双圈细线圆环间距分明，中间大图标与名字',
  },
]

/**
 * 规整数值以防出现 NaN 并保留两位小数
 *
 * @param val 输入待校验数值
 * @param fallback 兜底数值
 * @returns 规整后的有效数值
 * @example
 * ```ts
 * const safeX = safeNum(NaN, 0)
 * ```
 */
function safeNum(val: number, fallback = 0): number {
  return Number.isFinite(val) ? Math.round(val * 100) / 100 : fallback
}

/**
 * 根据可用宽度计算自适应收缩后的字号及字距
 *
 * @param text 文本字符串
 * @param baseSize 模板基准字号
 * @param fontScale 用户缩放倍率
 * @param spacingEm 字距倍率（em）
 * @param weight 字体字重
 * @param maxWidth 最大可用宽度
 * @returns 缩放后的字号、像素字距与估算渲染宽度
 * @example
 * ```ts
 * const { size, spacingPx, width } = fitFontSize('Arkli', 40, 1, 0, 700, 480)
 * ```
 */
function fitFontSize(
  text: string,
  baseSize: number,
  fontScale: number,
  spacingEm: number,
  weight: number,
  maxWidth: number
): { size: number; spacingPx: number; width: number } {
  const targetSize = baseSize * fontScale
  const initialSpacingPx = spacingEm * targetSize
  const initialWidth = estimateTextWidth(text, targetSize, weight, initialSpacingPx)

  if (initialWidth <= maxWidth) {
    return {
      size: safeNum(targetSize),
      spacingPx: safeNum(initialSpacingPx),
      width: safeNum(initialWidth),
    }
  }

  // 宽度超限时按比例等比缩小，严格收敛至最大可用宽度内
  const scaleRatio = maxWidth / initialWidth
  const scaledSize = targetSize * scaleRatio
  const finalSpacingPx = spacingEm * scaledSize
  const finalWidth = estimateTextWidth(text, scaledSize, weight, finalSpacingPx)

  return {
    size: safeNum(scaledSize),
    spacingPx: safeNum(finalSpacingPx),
    width: safeNum(finalWidth),
  }
}

/**
 * 根据参数生成 logo 画布图元场景
 *
 * @param p 用户配置的 logo 设计参数
 * @returns 包含画布宽高、底色及各绘制图元的场景对象
 * @example
 * ```ts
 * const scene = buildScene({
 *   template: 'stack',
 *   palette: 'tech-blue',
 *   icon: 'coffee',
 *   name: 'Arkli',
 *   slogan: '极简实用工具箱',
 *   font: 'sans-bold',
 *   fontScale: 1,
 *   spacing: 0,
 *   invert: false,
 * })
 * ```
 */
export function buildScene(p: LogoParams): Scene {
  // 1. 匹配模板元数据，未匹配时回退默认首套模板
  const template = TEMPLATES.find(item => item.id === p.template) || TEMPLATES[4]

  // 2. 配色处理：覆盖主色与反色计算
  const rawPalette = getPalette(p.palette)
  const palette = applyOverrides(rawPalette, p.primaryOverride, p.invert)

  // 3. 字体解析
  const font = getFont(p.font)

  // 4. 文案与参数边界夹取处理
  const effectiveName = p.name && p.name.trim().length > 0 ? p.name.trim() : DEFAULT_BRAND_NAME
  const effectiveSlogan = p.slogan && p.slogan.trim().length > 0 ? p.slogan.trim() : EMPTY_STRING
  const hasSlogan = effectiveSlogan.length > 0

  const fontScale = Number.isFinite(p.fontScale)
    ? Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, p.fontScale))
    : 1
  const spacingEm = Number.isFinite(p.spacing)
    ? Math.max(SPACING_MIN, Math.min(SPACING_MAX, p.spacing))
    : 0

  // 5. 图标数据匹配：wordmark 与 monogram 忽略图标；空串或未知图标视为无图标
  const ignoresIcon = template.id === TEMPLATE_WORDMARK || template.id === TEMPLATE_MONOGRAM
  const rawIconData = !ignoresIcon && p.icon ? ICON_DATA[p.icon] : undefined
  const hasIcon = Boolean(rawIconData)

  const items: SceneItem[] = []

  // 6. 各模板定制化几何布局计算
  switch (template.id) {
    case TEMPLATE_BADGE_CIRCLE: {
      const cx = CANVAS_CENTER_SQUARE
      const cy = CANVAS_CENTER_SQUARE
      const outerR = 255
      const innerR = 232

      // 圆外描边环
      items.push({
        k: ITEM_K_CIRCLE,
        cx,
        cy,
        r: outerR,
        stroke: palette.secondary,
        sw: STROKE_WIDTH_DEFAULT,
      })

      // 整圆底
      items.push({
        k: ITEM_K_CIRCLE,
        cx,
        cy,
        r: innerR,
        fill: `${palette.primary}${FILL_TINT_ALPHA}`,
        stroke: palette.primary,
        sw: STROKE_WIDTH_CONTAINER,
      })

      // 图标放大至内圆直径约 35%
      const iconSize = 162
      const baseNameSize = 46
      const baseSloganSize = 22
      const maxTextWidth = 360
      const gapIconText = 22
      const gapTextSlogan = 12

      const nameFit = fitFontSize(effectiveName, baseNameSize, fontScale, spacingEm, font.weight, maxTextWidth)
      const sloganSpacingEm = spacingEm + DEFAULT_SLOGAN_SPACING_EM
      const sloganFit = hasSlogan
        ? fitFontSize(effectiveSlogan, baseSloganSize, fontScale, sloganSpacingEm, WEIGHT_NORMAL, maxTextWidth - 40)
        : null

      const totalH = (hasIcon ? iconSize + gapIconText : 0) +
        nameFit.size +
        (sloganFit ? gapTextSlogan + sloganFit.size : 0)
      const startY = cy - totalH / 2

      let currentY = startY
      if (hasIcon && rawIconData) {
        items.push({
          k: ITEM_K_ICON,
          d: rawIconData.d,
          x: safeNum(cx - iconSize / 2),
          y: safeNum(currentY),
          size: iconSize,
          color: palette.primary,
          sw: STROKE_WIDTH_DEFAULT,
        })
        currentY += iconSize + gapIconText
      }

      items.push({
        k: ITEM_K_TEXT,
        text: effectiveName,
        x: cx,
        y: safeNum(currentY + nameFit.size * BASELINE_OFFSET_RATIO),
        size: nameFit.size,
        weight: font.weight,
        family: font.family,
        color: palette.text,
        anchor: ANCHOR_MIDDLE,
        spacing: nameFit.spacingPx,
        italic: font.italic,
      })
      currentY += nameFit.size

      if (sloganFit) {
        currentY += gapTextSlogan
        items.push({
          k: ITEM_K_TEXT,
          text: effectiveSlogan,
          x: cx,
          y: safeNum(currentY + sloganFit.size * BASELINE_OFFSET_RATIO),
          size: sloganFit.size,
          weight: WEIGHT_NORMAL,
          family: font.family,
          color: palette.secondary,
          anchor: ANCHOR_MIDDLE,
          spacing: sloganFit.spacingPx,
          italic: font.italic,
        })
      }
      break
    }

    case TEMPLATE_SQUARE_ROUND: {
      const cx = CANVAS_CENTER_SQUARE
      const cy = CANVAS_CENTER_SQUARE
      const boxSize = 460
      const boxOffset = (CANVAS_SIZE_SQUARE - boxSize) / 2
      const boxRadius = 48

      items.push({
        k: ITEM_K_RECT,
        x: boxOffset,
        y: boxOffset,
        w: boxSize,
        h: boxSize,
        rx: boxRadius,
        fill: `${palette.primary}${FILL_TINT_ALPHA}`,
        stroke: palette.primary,
        sw: STROKE_WIDTH_CONTAINER,
      })

      const iconSize = 140
      const baseNameSize = 48
      const baseSloganSize = 22
      const maxTextWidth = 380
      const gapIconText = 24
      const gapTextSlogan = 12

      const nameFit = fitFontSize(effectiveName, baseNameSize, fontScale, spacingEm, font.weight, maxTextWidth)
      const sloganSpacingEm = spacingEm + DEFAULT_SLOGAN_SPACING_EM
      const sloganFit = hasSlogan
        ? fitFontSize(effectiveSlogan, baseSloganSize, fontScale, sloganSpacingEm, WEIGHT_NORMAL, maxTextWidth - 40)
        : null

      const totalH = (hasIcon ? iconSize + gapIconText : 0) +
        nameFit.size +
        (sloganFit ? gapTextSlogan + sloganFit.size : 0)
      const startY = cy - totalH / 2

      let currentY = startY
      if (hasIcon && rawIconData) {
        items.push({
          k: ITEM_K_ICON,
          d: rawIconData.d,
          x: safeNum(cx - iconSize / 2),
          y: safeNum(currentY),
          size: iconSize,
          color: palette.primary,
          sw: STROKE_WIDTH_DEFAULT,
        })
        currentY += iconSize + gapIconText
      }

      items.push({
        k: ITEM_K_TEXT,
        text: effectiveName,
        x: cx,
        y: safeNum(currentY + nameFit.size * BASELINE_OFFSET_RATIO),
        size: nameFit.size,
        weight: font.weight,
        family: font.family,
        color: palette.text,
        anchor: ANCHOR_MIDDLE,
        spacing: nameFit.spacingPx,
        italic: font.italic,
      })
      currentY += nameFit.size

      if (sloganFit) {
        currentY += gapTextSlogan
        items.push({
          k: ITEM_K_TEXT,
          text: effectiveSlogan,
          x: cx,
          y: safeNum(currentY + sloganFit.size * BASELINE_OFFSET_RATIO),
          size: sloganFit.size,
          weight: WEIGHT_NORMAL,
          family: font.family,
          color: palette.secondary,
          anchor: ANCHOR_MIDDLE,
          spacing: sloganFit.spacingPx,
          italic: font.italic,
        })
      }
      break
    }

    case TEMPLATE_SHIELD: {
      const cx = CANVAS_CENTER_SQUARE

      // 主色实心盾外轮廓：饱满盾形且下尖明显（宽 440，高 470）
      items.push({
        k: ITEM_K_PATH,
        d: 'M 80 85 Q 300 65 520 85 L 520 280 C 520 415 390 495 300 535 C 210 495 80 415 80 280 Z',
        fill: palette.primary,
        stroke: palette.primary,
        sw: STROKE_WIDTH_CONTAINER,
      })

      // 描边内细辅色内线
      items.push({
        k: ITEM_K_PATH,
        d: 'M 94 99 Q 300 79 506 99 L 506 276 C 506 402 382 478 300 517 C 218 478 94 402 94 276 Z',
        stroke: palette.secondary,
        sw: STROKE_WIDTH_THIN,
      })

      // 图标放大至盾宽约 30%（440 * 0.3 = 132）
      const iconSize = 132
      const baseNameSize = 42
      const baseSloganSize = 22
      const maxTextWidth = 260
      const gapIconText = 22
      const gapTextSlogan = 12

      const nameFit = fitFontSize(effectiveName, baseNameSize, fontScale, spacingEm, font.weight, maxTextWidth)
      const sloganSpacingEm = spacingEm + DEFAULT_SLOGAN_SPACING_EM
      const sloganFit = hasSlogan
        ? fitFontSize(effectiveSlogan, baseSloganSize, fontScale, sloganSpacingEm, WEIGHT_NORMAL, maxTextWidth - 30)
        : null

      // 有图标时图标放盾上半部、名字放盾下半部；无图标时文字在盾中心垂直居中
      let currentY: number
      if (hasIcon) {
        currentY = 145
        if (rawIconData) {
          items.push({
            k: ITEM_K_ICON,
            d: rawIconData.d,
            x: safeNum(cx - iconSize / 2),
            y: safeNum(currentY),
            size: iconSize,
            color: palette.bg,
            sw: STROKE_WIDTH_DEFAULT,
          })
        }
        currentY += iconSize + gapIconText
      } else {
        const totalTextH = nameFit.size + (sloganFit ? gapTextSlogan + sloganFit.size : 0)
        currentY = 285 - totalTextH / 2
      }

      // 品牌名反白置于盾下半部
      items.push({
        k: ITEM_K_TEXT,
        text: effectiveName,
        x: cx,
        y: safeNum(currentY + nameFit.size * BASELINE_OFFSET_RATIO),
        size: nameFit.size,
        weight: font.weight,
        family: font.family,
        color: palette.bg,
        anchor: ANCHOR_MIDDLE,
        spacing: nameFit.spacingPx,
        italic: font.italic,
      })
      currentY += nameFit.size

      if (sloganFit) {
        currentY += gapTextSlogan
        items.push({
          k: ITEM_K_TEXT,
          text: effectiveSlogan,
          x: cx,
          y: safeNum(currentY + sloganFit.size * BASELINE_OFFSET_RATIO),
          size: sloganFit.size,
          weight: WEIGHT_NORMAL,
          family: font.family,
          color: palette.bg,
          anchor: ANCHOR_MIDDLE,
          spacing: sloganFit.spacingPx,
          italic: font.italic,
        })
      }
      break
    }

    case TEMPLATE_H_LOCKUP: {
      // 品牌名基准字号为画布高度约 16.2%，标语约 38.2%，图标约品牌名的 1.79 倍
      const baseNameSize = 68
      const baseSloganSize = 26
      const iconSize = 122
      const gapIconText = 32
      const gapTextSlogan = 12

      const maxTextWidth = hasIcon ? 560 : 720
      const nameFit = fitFontSize(effectiveName, baseNameSize, fontScale, spacingEm, font.weight, maxTextWidth)
      const sloganSpacingEm = spacingEm + DEFAULT_SLOGAN_SPACING_EM
      const sloganFit = hasSlogan
        ? fitFontSize(effectiveSlogan, baseSloganSize, fontScale, sloganSpacingEm, WEIGHT_NORMAL, maxTextWidth)
        : null

      const textBlockWidth = Math.max(nameFit.width, sloganFit ? sloganFit.width : 0)
      const totalContentW = (hasIcon ? iconSize + gapIconText : 0) + textBlockWidth
      const startX = (CANVAS_WIDTH_HORIZONTAL - totalContentW) / 2

      if (hasIcon && rawIconData) {
        const iconY = (CANVAS_HEIGHT_HORIZONTAL - iconSize) / 2
        items.push({
          k: ITEM_K_ICON,
          d: rawIconData.d,
          x: safeNum(startX),
          y: safeNum(iconY),
          size: iconSize,
          color: palette.primary,
          sw: STROKE_WIDTH_DEFAULT,
        })
      }

      const textLeft = hasIcon ? startX + iconSize + gapIconText : startX
      const textCenterX = textLeft + textBlockWidth / 2

      if (sloganFit) {
        const totalTextH = nameFit.size + gapTextSlogan + sloganFit.size
        const textTop = (CANVAS_HEIGHT_HORIZONTAL - totalTextH) / 2

        items.push({
          k: ITEM_K_TEXT,
          text: effectiveName,
          x: safeNum(textCenterX),
          y: safeNum(textTop + nameFit.size * BASELINE_OFFSET_RATIO),
          size: nameFit.size,
          weight: font.weight,
          family: font.family,
          color: palette.text,
          anchor: ANCHOR_MIDDLE,
          spacing: nameFit.spacingPx,
          italic: font.italic,
        })

        items.push({
          k: ITEM_K_TEXT,
          text: effectiveSlogan,
          x: safeNum(textCenterX),
          y: safeNum(textTop + nameFit.size + gapTextSlogan + sloganFit.size * BASELINE_OFFSET_RATIO),
          size: sloganFit.size,
          weight: WEIGHT_NORMAL,
          family: font.family,
          color: palette.secondary,
          anchor: ANCHOR_MIDDLE,
          spacing: sloganFit.spacingPx,
          italic: font.italic,
        })
      } else {
        items.push({
          k: ITEM_K_TEXT,
          text: effectiveName,
          x: safeNum(textCenterX),
          y: safeNum(CANVAS_CENTER_H_Y + nameFit.size * CENTER_BASELINE_OFFSET_RATIO),
          size: nameFit.size,
          weight: font.weight,
          family: font.family,
          color: palette.text,
          anchor: ANCHOR_MIDDLE,
          spacing: nameFit.spacingPx,
          italic: font.italic,
        })
      }
      break
    }

    case TEMPLATE_STACK: {
      const cx = CANVAS_CENTER_SQUARE
      const cy = CANVAS_CENTER_SQUARE
      const iconSize = 150
      const baseNameSize = 48
      const baseSloganSize = 22
      const maxTextWidth = 460
      const gapIconText = 24
      const gapTextSlogan = 14

      const nameFit = fitFontSize(effectiveName, baseNameSize, fontScale, spacingEm, font.weight, maxTextWidth)
      const sloganSpacingEm = spacingEm + DEFAULT_SLOGAN_SPACING_EM
      const sloganFit = hasSlogan
        ? fitFontSize(effectiveSlogan, baseSloganSize, fontScale, sloganSpacingEm, WEIGHT_NORMAL, maxTextWidth - 40)
        : null

      const totalH = (hasIcon ? iconSize + gapIconText : 0) +
        nameFit.size +
        (sloganFit ? gapTextSlogan + sloganFit.size : 0)
      const startY = cy - totalH / 2

      let currentY = startY
      if (hasIcon && rawIconData) {
        items.push({
          k: ITEM_K_ICON,
          d: rawIconData.d,
          x: safeNum(cx - iconSize / 2),
          y: safeNum(currentY),
          size: iconSize,
          color: palette.primary,
          sw: STROKE_WIDTH_DEFAULT,
        })
        currentY += iconSize + gapIconText
      }

      items.push({
        k: ITEM_K_TEXT,
        text: effectiveName,
        x: cx,
        y: safeNum(currentY + nameFit.size * BASELINE_OFFSET_RATIO),
        size: nameFit.size,
        weight: font.weight,
        family: font.family,
        color: palette.text,
        anchor: ANCHOR_MIDDLE,
        spacing: nameFit.spacingPx,
        italic: font.italic,
      })
      currentY += nameFit.size

      if (sloganFit) {
        currentY += gapTextSlogan
        items.push({
          k: ITEM_K_TEXT,
          text: effectiveSlogan,
          x: cx,
          y: safeNum(currentY + sloganFit.size * BASELINE_OFFSET_RATIO),
          size: sloganFit.size,
          weight: WEIGHT_NORMAL,
          family: font.family,
          color: palette.secondary,
          anchor: ANCHOR_MIDDLE,
          spacing: sloganFit.spacingPx,
          italic: font.italic,
        })
      }
      break
    }

    case TEMPLATE_MONOGRAM: {
      const cx = CANVAS_CENTER_SQUARE
      const rawFirstChar = effectiveName.trim()[0] || 'A'
      const initialChar = rawFirstChar.toUpperCase()

      // 方块占画布约 55%（330），首字大号占方块约 57.5%（190）
      const boxSize = 330
      const boxRadius = 48
      const monoFontSize = 190
      const baseNameSize = 46
      const baseSloganSize = 22
      const maxTextWidth = 460
      const gapBoxName = 26
      const gapNameSlogan = 12

      const nameFit = fitFontSize(effectiveName, baseNameSize, fontScale, spacingEm, font.weight, maxTextWidth)
      const sloganSpacingEm = spacingEm + DEFAULT_SLOGAN_SPACING_EM
      const sloganFit = hasSlogan
        ? fitFontSize(effectiveSlogan, baseSloganSize, fontScale, sloganSpacingEm, WEIGHT_NORMAL, maxTextWidth - 40)
        : null

      const totalH = boxSize + gapBoxName + nameFit.size + (sloganFit ? gapNameSlogan + sloganFit.size : 0)
      const startY = (CANVAS_SIZE_SQUARE - totalH) / 2

      const boxX = cx - boxSize / 2
      const boxY = startY

      // 首字大底框
      items.push({
        k: ITEM_K_RECT,
        x: safeNum(boxX),
        y: safeNum(boxY),
        w: boxSize,
        h: boxSize,
        rx: boxRadius,
        fill: palette.primary,
        stroke: palette.secondary,
        sw: STROKE_WIDTH_DEFAULT,
      })

      // 首字字符居中
      items.push({
        k: ITEM_K_TEXT,
        text: initialChar,
        x: cx,
        y: safeNum(boxY + boxSize / 2 + monoFontSize * CENTER_BASELINE_OFFSET_RATIO),
        size: monoFontSize,
        weight: font.weight,
        family: font.family,
        color: palette.bg,
        anchor: ANCHOR_MIDDLE,
        spacing: 0,
        italic: font.italic,
      })

      let currentY = boxY + boxSize + gapBoxName

      // 下方品牌名与标语
      items.push({
        k: ITEM_K_TEXT,
        text: effectiveName,
        x: cx,
        y: safeNum(currentY + nameFit.size * BASELINE_OFFSET_RATIO),
        size: nameFit.size,
        weight: font.weight,
        family: font.family,
        color: palette.text,
        anchor: ANCHOR_MIDDLE,
        spacing: nameFit.spacingPx,
        italic: font.italic,
      })
      currentY += nameFit.size

      if (sloganFit) {
        currentY += gapNameSlogan
        items.push({
          k: ITEM_K_TEXT,
          text: effectiveSlogan,
          x: cx,
          y: safeNum(currentY + sloganFit.size * BASELINE_OFFSET_RATIO),
          size: sloganFit.size,
          weight: WEIGHT_NORMAL,
          family: font.family,
          color: palette.secondary,
          anchor: ANCHOR_MIDDLE,
          spacing: sloganFit.spacingPx,
          italic: font.italic,
        })
      }
      break
    }

    case TEMPLATE_PILL: {
      // 胶囊外框撑满约 81% 画布宽度（730），高度 260
      const pillW = 730
      const pillH = 260
      const pillRx = pillH / 2
      const pillX = (CANVAS_WIDTH_HORIZONTAL - pillW) / 2
      const pillY = (CANVAS_HEIGHT_HORIZONTAL - pillH) / 2

      items.push({
        k: ITEM_K_RECT,
        x: safeNum(pillX),
        y: safeNum(pillY),
        w: pillW,
        h: pillH,
        rx: pillRx,
        fill: `${palette.primary}${FILL_TINT_ALPHA}`,
        stroke: palette.primary,
        sw: STROKE_WIDTH_CONTAINER,
      })

      const baseNameSize = 68
      const baseSloganSize = 26
      const iconSize = 122
      const gapIconText = 30
      const gapTextSlogan = 12

      const maxTextWidth = hasIcon ? 460 : 580
      const nameFit = fitFontSize(effectiveName, baseNameSize, fontScale, spacingEm, font.weight, maxTextWidth)
      const sloganSpacingEm = spacingEm + DEFAULT_SLOGAN_SPACING_EM
      const sloganFit = hasSlogan
        ? fitFontSize(effectiveSlogan, baseSloganSize, fontScale, sloganSpacingEm, WEIGHT_NORMAL, maxTextWidth)
        : null

      const textBlockWidth = Math.max(nameFit.width, sloganFit ? sloganFit.width : 0)
      const totalContentW = (hasIcon ? iconSize + gapIconText : 0) + textBlockWidth
      const startX = (CANVAS_WIDTH_HORIZONTAL - totalContentW) / 2

      if (hasIcon && rawIconData) {
        const iconY = (CANVAS_HEIGHT_HORIZONTAL - iconSize) / 2
        items.push({
          k: ITEM_K_ICON,
          d: rawIconData.d,
          x: safeNum(startX),
          y: safeNum(iconY),
          size: iconSize,
          color: palette.primary,
          sw: STROKE_WIDTH_DEFAULT,
        })
      }

      const textLeft = hasIcon ? startX + iconSize + gapIconText : startX
      const textCenterX = textLeft + textBlockWidth / 2

      if (sloganFit) {
        const totalTextH = nameFit.size + gapTextSlogan + sloganFit.size
        const textTop = (CANVAS_HEIGHT_HORIZONTAL - totalTextH) / 2

        items.push({
          k: ITEM_K_TEXT,
          text: effectiveName,
          x: safeNum(textCenterX),
          y: safeNum(textTop + nameFit.size * BASELINE_OFFSET_RATIO),
          size: nameFit.size,
          weight: font.weight,
          family: font.family,
          color: palette.text,
          anchor: ANCHOR_MIDDLE,
          spacing: nameFit.spacingPx,
          italic: font.italic,
        })

        items.push({
          k: ITEM_K_TEXT,
          text: effectiveSlogan,
          x: safeNum(textCenterX),
          y: safeNum(textTop + nameFit.size + gapTextSlogan + sloganFit.size * BASELINE_OFFSET_RATIO),
          size: sloganFit.size,
          weight: WEIGHT_NORMAL,
          family: font.family,
          color: palette.secondary,
          anchor: ANCHOR_MIDDLE,
          spacing: sloganFit.spacingPx,
          italic: font.italic,
        })
      } else {
        items.push({
          k: ITEM_K_TEXT,
          text: effectiveName,
          x: safeNum(textCenterX),
          y: safeNum(CANVAS_CENTER_H_Y + nameFit.size * CENTER_BASELINE_OFFSET_RATIO),
          size: nameFit.size,
          weight: font.weight,
          family: font.family,
          color: palette.text,
          anchor: ANCHOR_MIDDLE,
          spacing: nameFit.spacingPx,
          italic: font.italic,
        })
      }
      break
    }

    case TEMPLATE_WORDMARK: {
      const cx = CANVAS_CENTER_H_X
      const cy = CANVAS_CENTER_H_Y
      // 品牌名放大至占满画布宽度的约 70%（630~650）
      const baseNameSize = 98
      const baseSloganSize = 24
      const maxTextWidth = 650

      const nameFit = fitFontSize(effectiveName, baseNameSize, fontScale, spacingEm, font.weight, maxTextWidth)
      const sloganSpacingEm = spacingEm + 0.12
      const sloganFit = hasSlogan
        ? fitFontSize(effectiveSlogan, baseSloganSize, fontScale, sloganSpacingEm, WEIGHT_NORMAL, maxTextWidth - 80)
        : null

      // 加粗下划线装饰短横
      const lineWidth = Math.min(180, Math.max(80, nameFit.width * 0.35))
      const lineHeight = 8
      const gapNameLine = 20
      const gapLineSlogan = 18

      const totalH = nameFit.size +
        gapNameLine +
        lineHeight +
        (sloganFit ? gapLineSlogan + sloganFit.size : 0)
      const startY = cy - totalH / 2

      // 品牌名
      items.push({
        k: ITEM_K_TEXT,
        text: effectiveName,
        x: cx,
        y: safeNum(startY + nameFit.size * BASELINE_OFFSET_RATIO),
        size: nameFit.size,
        weight: font.weight,
        family: font.family,
        color: palette.text,
        anchor: ANCHOR_MIDDLE,
        spacing: nameFit.spacingPx,
        italic: font.italic,
      })

      // 主色粗短横线装饰
      const lineY = startY + nameFit.size + gapNameLine
      items.push({
        k: ITEM_K_RECT,
        x: safeNum(cx - lineWidth / 2),
        y: safeNum(lineY),
        w: safeNum(lineWidth),
        h: lineHeight,
        rx: lineHeight / 2,
        fill: palette.primary,
      })

      // 标语
      if (sloganFit) {
        const sloganY = lineY + lineHeight + gapLineSlogan
        items.push({
          k: ITEM_K_TEXT,
          text: effectiveSlogan,
          x: cx,
          y: safeNum(sloganY + sloganFit.size * BASELINE_OFFSET_RATIO),
          size: sloganFit.size,
          weight: WEIGHT_NORMAL,
          family: font.family,
          color: palette.secondary,
          anchor: ANCHOR_MIDDLE,
          spacing: sloganFit.spacingPx,
          italic: font.italic,
        })
      }
      break
    }

    case TEMPLATE_TAGLINE_STACK: {
      const cx = CANVAS_CENTER_SQUARE
      const cy = CANVAS_CENTER_SQUARE
      const iconSize = 135
      const baseNameSize = 48
      const baseSloganSize = 22
      const maxTextWidth = 460
      const gapIconText = 24
      const gapNameBlock = 18
      const lineGap = 10
      const lineHeight = 2.5

      const nameFit = fitFontSize(effectiveName, baseNameSize, fontScale, spacingEm, font.weight, maxTextWidth)

      let sloganFit: { size: number; spacingPx: number; width: number } | null = null
      let sloganBlockH = 0
      let lineWidth = 0

      if (hasSlogan) {
        const sloganSpacingEm = spacingEm + EXTRA_SLOGAN_SPACING_EM
        sloganFit = fitFontSize(effectiveSlogan, baseSloganSize, fontScale, sloganSpacingEm, WEIGHT_NORMAL, maxTextWidth - 60)
        lineWidth = Math.min(420, Math.max(180, sloganFit.width + 48))
        sloganBlockH = lineHeight + lineGap + sloganFit.size + lineGap + lineHeight
      }

      const totalH = (hasIcon ? iconSize + gapIconText : 0) +
        nameFit.size +
        (hasSlogan ? gapNameBlock + sloganBlockH : 0)
      const startY = cy - totalH / 2

      let currentY = startY
      if (hasIcon && rawIconData) {
        items.push({
          k: ITEM_K_ICON,
          d: rawIconData.d,
          x: safeNum(cx - iconSize / 2),
          y: safeNum(currentY),
          size: iconSize,
          color: palette.primary,
          sw: STROKE_WIDTH_DEFAULT,
        })
        currentY += iconSize + gapIconText
      }

      items.push({
        k: ITEM_K_TEXT,
        text: effectiveName,
        x: cx,
        y: safeNum(currentY + nameFit.size * BASELINE_OFFSET_RATIO),
        size: nameFit.size,
        weight: font.weight,
        family: font.family,
        color: palette.text,
        anchor: ANCHOR_MIDDLE,
        spacing: nameFit.spacingPx,
        italic: font.italic,
      })
      currentY += nameFit.size

      if (hasSlogan && sloganFit) {
        currentY += gapNameBlock

        // 标语上细线
        items.push({
          k: ITEM_K_RECT,
          x: safeNum(cx - lineWidth / 2),
          y: safeNum(currentY),
          w: safeNum(lineWidth),
          h: lineHeight,
          rx: 1,
          fill: palette.secondary,
        })
        currentY += lineHeight + lineGap

        // 标语文字（带额外字距）
        items.push({
          k: ITEM_K_TEXT,
          text: effectiveSlogan,
          x: cx,
          y: safeNum(currentY + sloganFit.size * BASELINE_OFFSET_RATIO),
          size: sloganFit.size,
          weight: WEIGHT_NORMAL,
          family: font.family,
          color: palette.secondary,
          anchor: ANCHOR_MIDDLE,
          spacing: sloganFit.spacingPx,
          italic: font.italic,
        })
        currentY += sloganFit.size + lineGap

        // 标语下细线
        items.push({
          k: ITEM_K_RECT,
          x: safeNum(cx - lineWidth / 2),
          y: safeNum(currentY),
          w: safeNum(lineWidth),
          h: lineHeight,
          rx: 1,
          fill: palette.secondary,
        })
      }
      break
    }

    case TEMPLATE_RING_SEAL: {
      const cx = CANVAS_CENTER_SQUARE
      const cy = CANVAS_CENTER_SQUARE
      const outerR = 260
      const innerR = 226

      // 双圈细线外圆环
      items.push({
        k: ITEM_K_CIRCLE,
        cx,
        cy,
        r: outerR,
        stroke: palette.primary,
        sw: STROKE_WIDTH_CONTAINER,
      })

      // 双圈细线内圆环（间距 34px）
      items.push({
        k: ITEM_K_CIRCLE,
        cx,
        cy,
        r: innerR,
        stroke: palette.secondary,
        sw: STROKE_WIDTH_DEFAULT,
      })

      // 图标放大至内圆直径约 35%（452 * 0.35 = 158）
      const iconSize = 158
      const baseNameSize = 46
      const baseSloganSize = 22
      const maxTextWidth = 360
      const gapIconText = 22
      const gapTextSlogan = 12

      const nameFit = fitFontSize(effectiveName, baseNameSize, fontScale, spacingEm, font.weight, maxTextWidth)
      const sloganSpacingEm = spacingEm + DEFAULT_SLOGAN_SPACING_EM
      const sloganFit = hasSlogan
        ? fitFontSize(effectiveSlogan, baseSloganSize, fontScale, sloganSpacingEm, WEIGHT_NORMAL, maxTextWidth - 40)
        : null

      const totalH = (hasIcon ? iconSize + gapIconText : 0) +
        nameFit.size +
        (sloganFit ? gapTextSlogan + sloganFit.size : 0)
      const startY = cy - totalH / 2

      let currentY = startY
      if (hasIcon && rawIconData) {
        items.push({
          k: ITEM_K_ICON,
          d: rawIconData.d,
          x: safeNum(cx - iconSize / 2),
          y: safeNum(currentY),
          size: iconSize,
          color: palette.primary,
          sw: STROKE_WIDTH_DEFAULT,
        })
        currentY += iconSize + gapIconText
      }

      items.push({
        k: ITEM_K_TEXT,
        text: effectiveName,
        x: cx,
        y: safeNum(currentY + nameFit.size * BASELINE_OFFSET_RATIO),
        size: nameFit.size,
        weight: font.weight,
        family: font.family,
        color: palette.text,
        anchor: ANCHOR_MIDDLE,
        spacing: nameFit.spacingPx,
        italic: font.italic,
      })
      currentY += nameFit.size

      if (sloganFit) {
        currentY += gapTextSlogan
        items.push({
          k: ITEM_K_TEXT,
          text: effectiveSlogan,
          x: cx,
          y: safeNum(currentY + sloganFit.size * BASELINE_OFFSET_RATIO),
          size: sloganFit.size,
          weight: WEIGHT_NORMAL,
          family: font.family,
          color: palette.secondary,
          anchor: ANCHOR_MIDDLE,
          spacing: sloganFit.spacingPx,
          italic: font.italic,
        })
      }
      break
    }
  }

  return {
    w: template.w,
    h: template.h,
    bg: palette.bg,
    items,
  }
}
