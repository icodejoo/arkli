// Logo 场景构建函数与各模板排版单测

import { describe, expect, it } from 'vitest'
import { buildScene, TEMPLATES } from './scene'
import { getPalette } from './palettes'
import { estimateTextWidth } from './fonts'
import { ICON_DATA } from './assets/iconData'
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  SPACING_MAX,
  SPACING_MIN,
} from './types'
import type { FontId, LogoParams, TemplateId } from './types'

// 模板标识常量
const TEST_TEMPLATE_STACK: TemplateId = 'stack'
const TEST_TEMPLATE_MONOGRAM: TemplateId = 'monogram'

// 配色与图标测试常量
const TEST_PALETTE_ID_TECH_BLUE = 'tech-blue'
const TEST_ICON_COFFEE = 'coffee'
const TEST_ICON_NOT_EXIST = 'non-existent-icon'
const CUSTOM_PRIMARY_OVERRIDE = '#ff3366'

// 字体与样式测试常量
const TEST_FONT_ID_SANS_BOLD: FontId = 'sans-bold'
const TEST_FONT_SCALE_NORMAL = 1.0
const TEST_FONT_SCALE_UNDERFLOW = 0.1
const TEST_FONT_SCALE_OVERFLOW = 2.5
const TEST_SPACING_DEFAULT = 0

// 样本文案常量
const SAMPLE_NAME_SHORT = 'Arkli'
const SAMPLE_NAME_LONG_40 = '长'.repeat(40)
const SAMPLE_NAME_LOWERCASE = 'arkli'
const SAMPLE_NAME_CJK = '方舟'
const SAMPLE_SLOGAN_STANDARD = '极简实用工具箱'
const SAMPLE_BLANK_SPACES = '   '
const EMPTY_STRING = ''

// 首字断言期望值常量
const EXPECTED_MONO_LETTER_UPPER = 'A'
const EXPECTED_MONO_CHAR_CJK = '方'

// 图元类型常量
const ITEM_TYPE_ICON = 'icon'
const ITEM_TYPE_TEXT = 'text'

// 对齐方式常量
const ANCHOR_TYPE_MIDDLE = 'middle'

describe('每个模板的基础场景构建', () => {
  it('所有 10 套预设模板均能生成有效场景且各项数值无 NaN', () => {
    for (const template of TEMPLATES) {
      const scene = buildScene({
        template: template.id,
        palette: TEST_PALETTE_ID_TECH_BLUE,
        icon: TEST_ICON_COFFEE,
        name: SAMPLE_NAME_SHORT,
        slogan: SAMPLE_SLOGAN_STANDARD,
        font: TEST_FONT_ID_SANS_BOLD,
        fontScale: TEST_FONT_SCALE_NORMAL,
        spacing: TEST_SPACING_DEFAULT,
        invert: false,
      })

      expect(scene.w).toBe(template.w)
      expect(scene.h).toBe(template.h)
      expect(scene.items.length).toBeGreaterThan(0)
      expect(scene.bg).toBeDefined()

      // 验证每一个图元的所有数值属性均非 NaN
      for (const item of scene.items) {
        for (const val of Object.values(item)) {
          if (typeof val === 'number') {
            expect(Number.isNaN(val)).toBe(false)
          }
        }
      }
    }
  })
})

describe('图标缺省与回退行为', () => {
  it('空图标串或不存在的图标名称不抛出异常且场景中不包含 icon 图元', () => {
    const emptyIconScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: EMPTY_STRING,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_SLOGAN_STANDARD,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const unknownIconScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_NOT_EXIST,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_SLOGAN_STANDARD,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    expect(emptyIconScene.items.some(it => it.k === ITEM_TYPE_ICON)).toBe(false)
    expect(unknownIconScene.items.some(it => it.k === ITEM_TYPE_ICON)).toBe(false)
  })

  it('配置有效图标时生成对应的 icon 图元且 path 的 d 属性精确匹配', () => {
    const scene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_SLOGAN_STANDARD,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const iconItem = scene.items.find(it => it.k === ITEM_TYPE_ICON)
    expect(iconItem).toBeDefined()
    if (iconItem && iconItem.k === ITEM_TYPE_ICON) {
      expect(iconItem.d).toBe(ICON_DATA[TEST_ICON_COFFEE].d)
      expect(iconItem.size).toBeGreaterThan(0)
    }
  })
})

describe('长文本自适应缩字号', () => {
  it('40 个字符的长品牌名自动缩小字号且估算总宽度不超出画布宽度', () => {
    const shortScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const longScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_LONG_40,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const shortText = shortScene.items.find(it => it.k === ITEM_TYPE_TEXT && it.text === SAMPLE_NAME_SHORT)
    const longText = longScene.items.find(it => it.k === ITEM_TYPE_TEXT && it.text === SAMPLE_NAME_LONG_40)

    expect(shortText).toBeDefined()
    expect(longText).toBeDefined()

    if (shortText && shortText.k === ITEM_TYPE_TEXT && longText && longText.k === ITEM_TYPE_TEXT) {
      expect(longText.size).toBeLessThan(shortText.size)

      const estimatedW = estimateTextWidth(longText.text, longText.size, longText.weight, longText.spacing)
      expect(estimatedW).toBeLessThanOrEqual(longScene.w)
    }
  })
})

describe('参数边界夹取处理', () => {
  it('fontScale 低于下限时夹取至下限，高于上限时夹取至上限', () => {
    const lowerBoundScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: FONT_SCALE_MIN,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const underflowScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_UNDERFLOW,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const upperBoundScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: FONT_SCALE_MAX,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const overflowScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_OVERFLOW,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const lowerText = lowerBoundScene.items.find(it => it.k === ITEM_TYPE_TEXT)
    const underflowText = underflowScene.items.find(it => it.k === ITEM_TYPE_TEXT)
    const upperText = upperBoundScene.items.find(it => it.k === ITEM_TYPE_TEXT)
    const overflowText = overflowScene.items.find(it => it.k === ITEM_TYPE_TEXT)

    if (lowerText && lowerText.k === ITEM_TYPE_TEXT && underflowText && underflowText.k === ITEM_TYPE_TEXT) {
      expect(underflowText.size).toBe(lowerText.size)
    }
    if (upperText && upperText.k === ITEM_TYPE_TEXT && overflowText && overflowText.k === ITEM_TYPE_TEXT) {
      expect(overflowText.size).toBe(upperText.size)
    }
  })

  it('标语为空串或纯空格时不产出标语文字图元且无空占位', () => {
    const emptySloganScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const blankSloganScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_BLANK_SPACES,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const emptyTexts = emptySloganScene.items.filter(it => it.k === ITEM_TYPE_TEXT)
    const blankTexts = blankSloganScene.items.filter(it => it.k === ITEM_TYPE_TEXT)

    expect(emptyTexts).toHaveLength(1)
    expect(blankTexts).toHaveLength(1)
    expect(emptyTexts[0].text).toBe(SAMPLE_NAME_SHORT)
    expect(blankTexts[0].text).toBe(SAMPLE_NAME_SHORT)
  })
})

describe('首字印记 monogram 特性', () => {
  it('正确提取品牌名首字符，若为拉丁字母则自动转换为大写', () => {
    const latinScene = buildScene({
      template: TEST_TEMPLATE_MONOGRAM,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_LOWERCASE,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const cjkScene = buildScene({
      template: TEST_TEMPLATE_MONOGRAM,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_CJK,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const latinMonoText = latinScene.items.find(it => it.k === ITEM_TYPE_TEXT && it.text === EXPECTED_MONO_LETTER_UPPER)
    const cjkMonoText = cjkScene.items.find(it => it.k === ITEM_TYPE_TEXT && it.text === EXPECTED_MONO_CHAR_CJK)

    expect(latinMonoText).toBeDefined()
    expect(cjkMonoText).toBeDefined()
  })
})

describe('配色反转与主色覆盖', () => {
  it('开启反转后画布背景色变更为基础配色原主色', () => {
    const defaultPalette = getPalette(TEST_PALETTE_ID_TECH_BLUE)
    const invertedScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: true,
    })

    expect(invertedScene.bg).toBe(defaultPalette.primary)
  })

  it('配置自定义主色后主色覆盖成功生效', () => {
    const overriddenScene = buildScene({
      template: TEST_TEMPLATE_STACK,
      palette: TEST_PALETTE_ID_TECH_BLUE,
      primaryOverride: CUSTOM_PRIMARY_OVERRIDE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: EMPTY_STRING,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const iconItem = overriddenScene.items.find(it => it.k === ITEM_TYPE_ICON)
    expect(iconItem).toBeDefined()
    if (iconItem && iconItem.k === ITEM_TYPE_ICON) {
      expect(iconItem.color).toBe(CUSTOM_PRIMARY_OVERRIDE)
    }
  })
})

describe('文字渲染边界约束', () => {
  it('全部模板及各参数配置下所有文字图元的估算水平范围均严格在画布边界内', () => {
    const testCases: Array<Partial<LogoParams>> = [
      { name: SAMPLE_NAME_SHORT, slogan: SAMPLE_SLOGAN_STANDARD },
      { name: SAMPLE_NAME_LONG_40, slogan: SAMPLE_SLOGAN_STANDARD },
      { name: SAMPLE_NAME_LONG_40, slogan: EMPTY_STRING, fontScale: FONT_SCALE_MAX, spacing: SPACING_MAX },
      { name: SAMPLE_NAME_SHORT, slogan: SAMPLE_NAME_LONG_40, fontScale: FONT_SCALE_MAX },
      { name: SAMPLE_NAME_CJK, slogan: SAMPLE_SLOGAN_STANDARD, spacing: SPACING_MIN },
    ]

    for (const t of TEMPLATES) {
      for (const tc of testCases) {
        const scene = buildScene({
          template: t.id,
          palette: TEST_PALETTE_ID_TECH_BLUE,
          icon: TEST_ICON_COFFEE,
          name: tc.name || SAMPLE_NAME_SHORT,
          slogan: tc.slogan ?? SAMPLE_SLOGAN_STANDARD,
          font: TEST_FONT_ID_SANS_BOLD,
          fontScale: tc.fontScale ?? TEST_FONT_SCALE_NORMAL,
          spacing: tc.spacing ?? TEST_SPACING_DEFAULT,
          invert: false,
        })

        for (const item of scene.items) {
          if (item.k === ITEM_TYPE_TEXT) {
            const w = estimateTextWidth(item.text, item.size, item.weight, item.spacing)
            const left = item.anchor === ANCHOR_TYPE_MIDDLE ? item.x - w / 2 : item.x
            const right = item.anchor === ANCHOR_TYPE_MIDDLE ? item.x + w / 2 : item.x + w

            expect(left).toBeGreaterThanOrEqual(0)
            expect(right).toBeLessThanOrEqual(scene.w)
          }
        }
      }
    }
  })
})

describe('各模板视觉比例与排版修正规范', () => {
  it('所有模板标语基准字号均不小于 22px', () => {
    for (const t of TEMPLATES) {
      const scene = buildScene({
        template: t.id,
        palette: TEST_PALETTE_ID_TECH_BLUE,
        icon: TEST_ICON_COFFEE,
        name: SAMPLE_NAME_SHORT,
        slogan: SAMPLE_SLOGAN_STANDARD,
        font: TEST_FONT_ID_SANS_BOLD,
        fontScale: TEST_FONT_SCALE_NORMAL,
        spacing: TEST_SPACING_DEFAULT,
        invert: false,
      })

      const sloganText = scene.items.find(it => it.k === ITEM_TYPE_TEXT && it.text === SAMPLE_SLOGAN_STANDARD)
      expect(sloganText).toBeDefined()
      if (sloganText && sloganText.k === ITEM_TYPE_TEXT) {
        expect(sloganText.size).toBeGreaterThanOrEqual(22)
      }
    }
  })

  it('shield 盾形为主色实心盾、内含辅色内线，图标与名字反白且图标约占盾宽 30%', () => {
    const palette = getPalette(TEST_PALETTE_ID_TECH_BLUE)
    const scene = buildScene({
      template: 'shield',
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_SLOGAN_STANDARD,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const paths = scene.items.filter(it => it.k === 'path')
    expect(paths.length).toBeGreaterThanOrEqual(2)
    const shieldPath = paths[0]
    const innerPath = paths[1]

    if (shieldPath.k === 'path') {
      expect(shieldPath.fill).toBe(palette.primary)
    }
    if (innerPath.k === 'path') {
      expect(innerPath.stroke).toBe(palette.secondary)
    }

    const iconItem = scene.items.find(it => it.k === ITEM_TYPE_ICON)
    const nameItem = scene.items.find(it => it.k === ITEM_TYPE_TEXT && it.text === SAMPLE_NAME_SHORT)

    expect(iconItem).toBeDefined()
    expect(nameItem).toBeDefined()
    if (iconItem && iconItem.k === ITEM_TYPE_ICON) {
      expect(iconItem.color).toBe(palette.bg)
      // 盾宽 440，图标尺寸 132，约占 30%
      expect(iconItem.size).toBe(132)
    }
    if (nameItem && nameItem.k === ITEM_TYPE_TEXT) {
      expect(nameItem.color).toBe(palette.bg)
      // 名字位于盾下半部 (y > 300)
      expect(nameItem.y).toBeGreaterThan(300)
    }
  })

  it('monogram 底框约占画布 55%，首字大号占方块约 57.5%，整体垂直居中', () => {
    const scene = buildScene({
      template: 'monogram',
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_SLOGAN_STANDARD,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const rect = scene.items.find(it => it.k === 'rect')
    const monoChar = scene.items.find(it => it.k === ITEM_TYPE_TEXT && it.text === EXPECTED_MONO_LETTER_UPPER)

    expect(rect).toBeDefined()
    expect(monoChar).toBeDefined()
    if (rect && rect.k === 'rect') {
      expect(rect.w).toBe(330)
      expect(rect.h).toBe(330)
      expect(rect.y).toBeGreaterThanOrEqual(70)
    }
    if (monoChar && monoChar.k === ITEM_TYPE_TEXT) {
      expect(monoChar.size).toBe(190)
    }
  })

  it('pill 胶囊外框撑满约 80% 宽，横版模板品牌名与图标按比例放大', () => {
    const pillScene = buildScene({
      template: 'pill',
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_SLOGAN_STANDARD,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const pillRect = pillScene.items.find(it => it.k === 'rect')
    expect(pillRect).toBeDefined()
    if (pillRect && pillRect.k === 'rect') {
      // 胶囊撑满约 80% 宽度 (730 / 900 ≈ 81%)
      expect(pillRect.w).toBeGreaterThanOrEqual(720)
    }

    const hLockupScene = buildScene({
      template: 'h-lockup',
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_SLOGAN_STANDARD,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const nameText = hLockupScene.items.find(it => it.k === ITEM_TYPE_TEXT && it.text === SAMPLE_NAME_SHORT)
    const icon = hLockupScene.items.find(it => it.k === ITEM_TYPE_ICON)
    if (nameText && nameText.k === ITEM_TYPE_TEXT && icon && icon.k === ITEM_TYPE_ICON) {
      // 品牌名基准字号为画布高的 14%~18%（420 的 14%~18% 即 58~75）
      expect(nameText.size).toBeGreaterThanOrEqual(58)
      expect(nameText.size).toBeLessThanOrEqual(76)
      // 图标约为品牌名字号的 1.6~2 倍
      expect(icon.size / nameText.size).toBeGreaterThanOrEqual(1.6)
      expect(icon.size / nameText.size).toBeLessThanOrEqual(2.0)
    }
  })

  it('badge-circle 与 ring-seal 圆内图标放大至直径约 35%，ring-seal 双圈间距明显', () => {
    const badgeScene = buildScene({
      template: 'badge-circle',
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_SLOGAN_STANDARD,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const sealScene = buildScene({
      template: 'ring-seal',
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_SLOGAN_STANDARD,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const badgeIcon = badgeScene.items.find(it => it.k === ITEM_TYPE_ICON)
    const sealIcon = sealScene.items.find(it => it.k === ITEM_TYPE_ICON)
    expect(badgeIcon).toBeDefined()
    expect(sealIcon).toBeDefined()
    if (badgeIcon && badgeIcon.k === ITEM_TYPE_ICON) {
      expect(badgeIcon.size).toBeGreaterThanOrEqual(155)
    }
    if (sealIcon && sealIcon.k === ITEM_TYPE_ICON) {
      expect(sealIcon.size).toBeGreaterThanOrEqual(155)
    }

    const circles = sealScene.items.filter(it => it.k === 'circle')
    expect(circles.length).toBe(2)
    if (circles[0].k === 'circle' && circles[1].k === 'circle') {
      const ringGap = Math.abs(circles[0].r - circles[1].r)
      expect(ringGap).toBeGreaterThanOrEqual(30)
    }
  })

  it('wordmark 品牌名字号与装饰短横线均明显加粗放大', () => {
    const scene = buildScene({
      template: 'wordmark',
      palette: TEST_PALETTE_ID_TECH_BLUE,
      icon: TEST_ICON_COFFEE,
      name: SAMPLE_NAME_SHORT,
      slogan: SAMPLE_SLOGAN_STANDARD,
      font: TEST_FONT_ID_SANS_BOLD,
      fontScale: TEST_FONT_SCALE_NORMAL,
      spacing: TEST_SPACING_DEFAULT,
      invert: false,
    })

    const nameText = scene.items.find(it => it.k === ITEM_TYPE_TEXT && it.text === SAMPLE_NAME_SHORT)
    const underline = scene.items.find(it => it.k === 'rect')

    expect(nameText).toBeDefined()
    expect(underline).toBeDefined()
    if (nameText && nameText.k === ITEM_TYPE_TEXT) {
      expect(nameText.size).toBeGreaterThanOrEqual(90)
    }
    if (underline && underline.k === 'rect') {
      expect(underline.h).toBeGreaterThanOrEqual(6)
    }
  })
})
