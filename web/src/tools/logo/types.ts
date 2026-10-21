// logo 设计：参数与场景模型。参数 → 场景（布局，纯函数） → SVG 字符串 / Canvas 绘制，两个后端共用同一份场景，保证预览与导出一致。

/** 模板 id */
export type TemplateId =
  | 'badge-circle'
  | 'square-round'
  | 'shield'
  | 'h-lockup'
  | 'stack'
  | 'monogram'
  | 'pill'
  | 'wordmark'
  | 'tagline-stack'
  | 'ring-seal'

/** 字体 id（系统字体栈，见 fonts.ts） */
export type FontId = 'sans-bold' | 'sans' | 'serif' | 'serif-bold' | 'mono' | 'rounded'

/** 一套配色 */
export interface Palette {
  /** 配色 id */
  id: string
  /** 中文名 */
  name: string
  /** 风格标签（给智能排版与关键词规则用）：warm 暖 / cool 冷 / dark 深色 / light 浅色 / vivid 鲜艳 / calm 沉稳 / natural 自然 / elegant 高级 */
  tags: string[]
  /** 主色（图形、强调） */
  primary: string
  /** 辅色（点缀、描边、标语） */
  secondary: string
  /** 背景色 */
  bg: string
  /** 文字色（品牌名） */
  text: string
}

/** AI 符号版式 id：圆环徽章 / 实心圆 / 圆角方块（上图下字）/ 横排（左图右字） */
export type SymbolLayoutId = 'ai-ring' | 'ai-solid' | 'ai-square' | 'ai-lockup'

/** AI 符号的一条路径：d 为 512 坐标系下的路径，(tx, ty) 为 vtracer 给的平移 */
export interface SymbolPath {
  /** 路径数据 */
  d: string
  /** x 平移 */
  tx: number
  /** y 平移 */
  ty: number
}

/** 一个 AI 生成的单色符号（与版式一起放进 LogoParams，可序列化） */
export interface AiSymbol {
  /** 版式 */
  layout: SymbolLayoutId
  /** 路径所在方形坐标系的边长（原生固定 512） */
  vb: number
  /** 路径列表 */
  paths: SymbolPath[]
}

/** 用户可调的 logo 参数（全部可序列化） */
export interface LogoParams {
  /** 模板 id */
  template: TemplateId
  /** 配色 id */
  palette: string
  /** 自定义主色（#rrggbb）；有值时覆盖配色的主色 */
  primaryOverride?: string
  /** 图标名（ICON_DATA 的 key）；空串表示不要图标 */
  icon: string
  /** 品牌名 */
  name: string
  /** 标语，可空 */
  slogan: string
  /** 字体 id */
  font: FontId
  /** 品牌名字号微调倍率，1 为模板默认，范围 [FONT_SCALE_MIN, FONT_SCALE_MAX] */
  fontScale: number
  /** 字距，单位 em，范围 [SPACING_MIN, SPACING_MAX] */
  spacing: number
  /** 是否反色：对调背景与主色，文字跟着变（深↔浅） */
  invert: boolean
  /** AI 符号；有值时按 symbol.layout 排版，template 与 icon 不再起作用 */
  symbol?: AiSymbol
}

/** 字号倍率下限 */
export const FONT_SCALE_MIN = 0.6
/** 字号倍率上限 */
export const FONT_SCALE_MAX = 1.4
/** 字距下限（em） */
export const SPACING_MIN = -0.05
/** 字距上限（em） */
export const SPACING_MAX = 0.3

/** 描边与填充：color 为 CSS 颜色，缺省不画 */
interface Paint {
  /** 填充色 */
  fill?: string
  /** 描边色 */
  stroke?: string
  /** 描边宽 */
  sw?: number
}

/** 矩形（rx 为圆角半径） */
export interface RectItem extends Paint {
  /** 类型 */
  k: 'rect'
  /** 左上角 x */
  x: number
  /** 左上角 y */
  y: number
  /** 宽 */
  w: number
  /** 高 */
  h: number
  /** 圆角半径 */
  rx: number
}

/** 圆 */
export interface CircleItem extends Paint {
  /** 类型 */
  k: 'circle'
  /** 圆心 x */
  cx: number
  /** 圆心 y */
  cy: number
  /** 半径 */
  r: number
}

/** 任意路径（绝对坐标，d 只含 M L H V C S Q T A Z 及其小写） */
export interface PathItem extends Paint {
  /** 类型 */
  k: 'path'
  /** path 的 d */
  d: string
}

/** 图标：Lucide 24x24 描边图标，按 size 缩放到 (x,y) 左上角处 */
export interface IconItem {
  /** 类型 */
  k: 'icon'
  /** 图标的 path 数据（24x24 视窗） */
  d: string
  /** 左上角 x */
  x: number
  /** 左上角 y */
  y: number
  /** 边长 */
  size: number
  /** 线条颜色 */
  color: string
  /** 线宽（24 视窗内的单位，Lucide 默认 2） */
  sw: number
}

/** 文字：x 为锚点（anchor 决定对齐），y 为基线 */
export interface TextItem {
  /** 类型 */
  k: 'text'
  /** 内容（原文，转义由后端负责） */
  text: string
  /** 锚点 x */
  x: number
  /** 基线 y */
  y: number
  /** 字号（px） */
  size: number
  /** 字重 400 / 700 / 900 */
  weight: number
  /** 字体栈（CSS font-family 值） */
  family: string
  /** 颜色 */
  color: string
  /** 对齐 */
  anchor: 'start' | 'middle'
  /** 字距（px），0 为默认 */
  spacing: number
  /** 是否斜体 */
  italic?: boolean
}

/** AI 符号：边长 vb 的方形坐标系缩放到 (x,y) 左上角、边长 size 处，用单色 color 填充 */
export interface SymbolItem {
  /** 类型 */
  k: 'symbol'
  /** 路径列表 */
  paths: SymbolPath[]
  /** 原坐标系边长 */
  vb: number
  /** 左上角 x */
  x: number
  /** 左上角 y */
  y: number
  /** 缩放后的边长 */
  size: number
  /** 填充色 */
  color: string
}

/** 场景里的一项 */
export type SceneItem = RectItem | CircleItem | PathItem | IconItem | TextItem | SymbolItem

/** 一张 logo 的场景：画布尺寸、底色与按绘制顺序排列的图元 */
export interface Scene {
  /** 画布宽 */
  w: number
  /** 画布高 */
  h: number
  /** 画布底色 */
  bg: string
  /** 图元，先画的在下 */
  items: SceneItem[]
}
