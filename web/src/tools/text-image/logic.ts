import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE } from '@/shared/image-calc'

/** 文本测宽函数：返回字符串在当前字体下的像素宽（实际用 ctx.measureText，测试里可注入） */
export type Measure = (text: string) => number

/** 对齐方式 */
export type TextAlign = 'left' | 'center' | 'right'

/** 排版参数 */
export interface LayoutOptions {
  /** 画布宽（像素） */
  width: number
  /** 字号（像素） */
  fontSize: number
  /** 行距倍数，如 1.6 */
  lineHeightRatio: number
  /** 四周内边距（像素） */
  padding: number
  /** 单张最大高度上限，0 表示只受画布上限约束 */
  heightCap: number
  /** 页脚文字，空串表示没有 */
  footer: string
}

/** 一页（一张图）的排版结果 */
export interface Page {
  /** 本页的行 */
  lines: string[]
  /** 画布宽 */
  width: number
  /** 画布高 */
  height: number
}

/** 字符簇类型：空白 / 英文数字等连写字符 / 中日韩及其他需逐字断行的字符 */
type Kind = 'space' | 'word' | 'cjk'

/** 一个断行单元 */
interface Token {
  /** 文本 */
  text: string
  /** 类型 */
  kind: Kind
}

/** 不能出现在行首的标点（遇到时悬挂在上一行末尾） */
const NO_LINE_START = '，。、；：！？）》」』】〕”’…—～·％'
/** 不能出现在行尾的标点（遇到时随下一字换到下一行） */
const NO_LINE_END = '（《「『【〔“‘'
/** 该码点以上的字符按“逐字断行”处理（CJK 部首区起） */
const CJK_FROM = 0x2e80
/** 零宽连接符 / 变体选择符 / 肤色修饰符范围 */
const ZWJ = 0x200d
const VS16 = 0xfe0f
const SKIN_FROM = 0x1f3fb
const SKIN_TO = 0x1f3ff
/** Tab 展开成的空格数 */
const TAB_SPACES = '  '
/** 页脚字号相对正文的比例与下限 */
const FOOTER_RATIO = 0.6
const FOOTER_MIN = 12
/** 页脚区上下留白（占页脚字号的倍数） */
const FOOTER_GAP_RATIO = 2.4
/** 渐变线计算的小数精度 */
const PRECISION = 1e6

/** 背景预设 */
export interface BgPreset {
  /** 名称 */
  name: string
  /** 起始色 */
  c1: string
  /** 结束色，与起始色相同即纯色 */
  c2: string
  /** 建议文字色 */
  text: string
}

/** 常用背景预设（含配套文字色） */
export const BG_PRESETS: BgPreset[] = [
  { name: '纸白', c1: '#ffffff', c2: '#ffffff', text: '#222222' },
  { name: '米黄', c1: '#f6efdd', c2: '#f6efdd', text: '#3d3427' },
  { name: '夜黑', c1: '#1c1c1e', c2: '#1c1c1e', text: '#f2f2f7' },
  { name: '极光', c1: '#667eea', c2: '#764ba2', text: '#ffffff' },
  { name: '日落', c1: '#f093fb', c2: '#f5576c', text: '#ffffff' },
  { name: '海湾', c1: '#4facfe', c2: '#00f2fe', text: '#10343f' },
]

/** 判断码点是否属于需要并入前一个字符簇的修饰符 */
function isJoiner(cp: number): boolean {
  return cp === ZWJ || cp === VS16 || (cp >= SKIN_FROM && cp <= SKIN_TO)
}

/** 把字符串拆成字符簇：代理对不拆开，emoji 的 ZWJ 序列 / 变体选择符 / 肤色修饰并入前一簇 */
function clusters(s: string): string[] {
  const out: string[] = []
  let joinNext = false
  for (const ch of Array.from(s)) {
    const cp = ch.codePointAt(0)!
    if (out.length && (isJoiner(cp) || joinNext)) {
      out[out.length - 1] += ch
      joinNext = cp === ZWJ
    } else {
      out.push(ch)
      joinNext = false
    }
  }
  return out
}

/** 判断一个字符簇的类型 */
function kindOf(c: string): Kind {
  if (c === ' ' || c === '　') return 'space'
  return c.codePointAt(0)! >= CJK_FROM ? 'cjk' : 'word'
}

/** 把一段文字切成断行单元：连续英文数字合成一个词，其他逐字 */
function tokenize(s: string): Token[] {
  const out: Token[] = []
  for (const c of clusters(s)) {
    const kind = kindOf(c)
    const last = out[out.length - 1]
    if (kind === 'word' && last && last.kind === 'word') last.text += c
    else out.push({ text: c, kind })
  }
  return out
}

/** 去掉行尾空白 */
function trimEnd(s: string): string {
  return s.replace(/[ 　]+$/, '')
}

/** 一段（无换行）文字排成多行 */
function wrapParagraph(para: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = []
  let line = ''
  const queue = tokenize(para)
  while (queue.length) {
    const t = queue.shift()!
    if (t.kind === 'space') {
      // 折行后的行首空白丢掉；行内空白直接接上（即使超宽也只是行尾悬挂）
      if (line || lines.length === 0) line += t.text
      continue
    }
    if (measure(line + t.text) <= maxWidth) {
      line += t.text
      continue
    }
    // 避头：行首禁用的标点悬挂在上一行末尾
    if (line && t.kind === 'cjk' && NO_LINE_START.indexOf(t.text) >= 0) {
      line += t.text
      continue
    }
    if (line) {
      // 避尾：行尾的开括号等跟着下一字走
      let carry = ''
      let cs = clusters(trimEnd(line))
      while (cs.length > 1 && NO_LINE_END.indexOf(cs[cs.length - 1]) >= 0) carry = cs.pop()! + carry
      line = cs.join('')
      lines.push(trimEnd(line))
      line = carry
      queue.unshift(t)
      continue
    }
    // 行是空的却放不下：超长单词按字符强拆；单个字符放不下就硬放一个
    const cs = clusters(t.text)
    let take = cs[0]
    let n = 1
    while (n < cs.length && measure(take + cs[n]) <= maxWidth) take += cs[n++]
    lines.push(take)
    if (n < cs.length) queue.unshift({ text: cs.slice(n).join(''), kind: t.kind })
  }
  if (line || lines.length === 0) lines.push(trimEnd(line))
  return lines
}

/**
 * 自动换行：中文按字、英文按词（超长词强拆），支持 `\n` 分段与空行，行首避开标点、行尾避开开括号，emoji 不拆开。
 *
 * @param text 原文
 * @param maxWidth 每行最大宽度（像素）
 * @param measure 测宽函数，测试可注入
 * @returns 行数组；空文本返回空数组
 * @example wrapText('你好，世界', 40, (s) => s.length * 20) // ['你好', '，世', '界'] 之类，标点会悬挂而不落行首
 */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  if (!text) return []
  const paras = text.replace(/\r\n?/g, '\n').replace(/\t/g, TAB_SPACES).split('\n')
  const lines: string[] = []
  for (const p of paras) lines.push(...(p ? wrapParagraph(p, maxWidth, measure) : ['']))
  return lines
}

/**
 * 页脚字号。
 *
 * @param fontSize 正文字号
 * @returns 页脚字号（整数，不小于 12）
 */
export function footerFontSize(fontSize: number): number {
  return Math.max(FOOTER_MIN, Math.round(fontSize * FOOTER_RATIO))
}

/**
 * 页脚区高度。
 *
 * @param fontSize 正文字号
 * @param footer 页脚文字
 * @returns 有页脚返回高度（含上下留白），没有返回 0
 */
export function footerHeight(fontSize: number, footer: string): number {
  return footer ? Math.round(footerFontSize(fontSize) * FOOTER_GAP_RATIO) : 0
}

/**
 * 单张图最大高度：受单边上限、总像素上限和用户设定共同约束。
 *
 * @param width 画布宽
 * @param cap 用户设定上限，0 表示不额外限制
 * @returns 最大高度（整数）
 * @example maxPageHeight(1080, 0) // 16384
 */
export function maxPageHeight(width: number, cap: number): number {
  const byArea = Math.floor(MAX_CANVAS_PIXELS / Math.max(1, width))
  const limit = Math.min(MAX_CANVAS_SIDE, byArea)
  return cap > 0 ? Math.min(limit, cap) : limit
}

/**
 * 把行切成多页。每页至少放一行；翻页处的前导空行与页尾空行会被去掉。
 *
 * @param lines 全部行
 * @param perPage 每页最多行数
 * @returns 页列表
 * @example paginate(['a', 'b', 'c'], 2) // [['a', 'b'], ['c']]
 */
export function paginate(lines: string[], perPage: number): string[][] {
  const size = Math.max(1, Math.floor(perPage))
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += size) {
    const chunk = lines.slice(i, i + size)
    while (chunk.length > 1 && chunk[0] === '' && i > 0) chunk.shift()
    while (chunk.length > 1 && chunk[chunk.length - 1] === '') chunk.pop()
    pages.push(chunk)
  }
  return pages
}

/**
 * 一行文字的起始 x。
 *
 * @param align 对齐方式
 * @param padding 内边距
 * @param contentWidth 内容区宽度
 * @param lineWidth 该行文字宽度
 * @returns 绘制起点 x（textAlign 用 left）
 * @example alignX('center', 40, 400, 100) // 190
 */
export function alignX(align: TextAlign, padding: number, contentWidth: number, lineWidth: number): number {
  if (align === 'center') return padding + (contentWidth - lineWidth) / 2
  if (align === 'right') return padding + contentWidth - lineWidth
  return padding
}

/**
 * 整体排版：换行 + 按高度上限分页，算出每页画布尺寸。
 *
 * @param text 原文
 * @param opts 排版参数
 * @param measure 测宽函数（须已设好字体）
 * @returns 页列表；文本为空返回空数组
 * @example layoutPages('很长的文字', { width: 1080, fontSize: 40, lineHeightRatio: 1.6, padding: 60, heightCap: 0, footer: '' }, measure)
 */
export function layoutPages(text: string, opts: LayoutOptions, measure: Measure): Page[] {
  const contentW = Math.max(1, opts.width - opts.padding * 2)
  const lines = wrapText(text, contentW, measure)
  if (!lines.length) return []
  const lineH = Math.round(opts.fontSize * opts.lineHeightRatio)
  const foot = footerHeight(opts.fontSize, opts.footer)
  const room = maxPageHeight(opts.width, opts.heightCap) - opts.padding * 2 - foot
  const perPage = Math.max(1, Math.floor(room / lineH))
  return paginate(lines, perPage).map((ls) => ({
    lines: ls,
    width: opts.width,
    height: opts.padding * 2 + ls.length * lineH + foot,
  }))
}

/**
 * 渐变线两端坐标（角度 0 为从下往上，90 为从左往右，同 CSS linear-gradient），覆盖整个矩形。
 *
 * @param w 画布宽
 * @param h 画布高
 * @param angleDeg 角度（度）
 * @returns 起止点
 * @example gradientLine(100, 100, 90) // { x0: 0, y0: 50, x1: 100, y1: 50 }
 */
export function gradientLine(w: number, h: number, angleDeg: number): { x0: number; y0: number; x1: number; y1: number } {
  const rad = (angleDeg * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad)
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2
  const r = (n: number) => Math.round(n * PRECISION) / PRECISION
  return { x0: r(w / 2 - dx * half), y0: r(h / 2 - dy * half), x1: r(w / 2 + dx * half), y1: r(h / 2 + dy * half) }
}
