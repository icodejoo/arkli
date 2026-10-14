// 对联：句库校验（等长、横批、平仄收尾粗检）、随机挑选、手写对联的竖排布局与绘制
import { pick, type RandomSource } from '@/shared/random'
import { COUPLETS, THEMES, type Couplet, type ThemeId } from './data'

/** 横批字数 */
export const BANNER_LEN = 4
/** 手写对联单联最多字数 */
export const CUSTOM_MAX_LEN = 16
/** 常见字数筛选项 */
export const LENGTH_OPTIONS: readonly number[] = [4, 5, 7]

/** 收尾字的仄声字表（现代汉语三声、四声），库内用到的结尾字都要登记在这里或平声表里 */
export const OBLIQUE_ENDINGS =
  '绿好岁客意顺绣在晓乐里字笑久印鸟睦事缔配广气至绕暖日到贺旺照喜下聚业展运老盛永寿树敬满健阔院物果住度理'
/** 收尾字的平声字表（现代汉语一声、二声） */
export const LEVEL_ENDINGS =
  '欢长春祥庭隆安颜康来年兴房缘圆成堂莲贤浓高时光霞方朋通临程开辰张疆松生真游容德留门'

/** 对联库校验不通过时的白名单：键为上联，值为放行原因。目前库里没有例外 */
export const TONE_EXCEPTIONS: Readonly<Record<string, string>> = {}

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
 * 查某字的声调类别（只认库里登记过的收尾字）。
 *
 * @param ch 单个汉字
 * @returns '平' / '仄'；没登记返回 null
 * @example toneOf('欢') // '平'
 */
export function toneOf(ch: string): '平' | '仄' | null {
  if ([...ch].length !== 1) return null
  if (LEVEL_ENDINGS.indexOf(ch) >= 0) return '平'
  if (OBLIQUE_ENDINGS.indexOf(ch) >= 0) return '仄'
  return null
}

/**
 * 校验一副对联，返回全部问题（空数组表示通过）。
 *
 * 检查：上下联等长且不为空、横批 4 字、上联仄收、下联平收、上下联同位置不得是同一个字。
 *
 * @param p 对联
 * @returns 问题描述列表
 * @example validateCouplet({ up: '风调雨顺', down: '国泰民安', banner: '五谷丰登' }) // []
 */
export function validateCouplet(p: Couplet): string[] {
  const issues: string[] = []
  const up = [...p.up]
  const down = [...p.down]
  if (!up.length || up.length !== down.length) issues.push('上下联字数不等')
  if ([...p.banner].length !== BANNER_LEN) issues.push(`横批不是 ${BANNER_LEN} 字`)
  if (!(p.up in TONE_EXCEPTIONS)) {
    const t1 = toneOf(up[up.length - 1] ?? '')
    const t2 = toneOf(down[down.length - 1] ?? '')
    if (t1 !== '仄') issues.push(t1 === null ? '上联收尾字未登记平仄' : '上联未以仄声收尾')
    if (t2 !== '平') issues.push(t2 === null ? '下联收尾字未登记平仄' : '下联未以平声收尾')
  }
  for (let i = 0; i < Math.min(up.length, down.length); i++) {
    if (up[i] === down[i]) issues.push(`第 ${i + 1} 字上下联相同`)
  }
  return issues
}

/**
 * 找出库里重复的上联或下联。
 *
 * @param list 对联列表
 * @returns 重复出现的句子（去重后）
 * @example findDuplicates([a, a]) // [a.up, a.down]
 */
export function findDuplicates(list: readonly Couplet[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const p of list) {
    for (const s of [p.up, p.down]) {
      if (seen.has(s)) dup.add(s)
      seen.add(s)
    }
  }
  return Array.from(dup)
}

/**
 * 取某主题的全部对联。
 *
 * @param theme 主题
 * @returns 该主题对联列表
 * @example themeCouplets('spring').length
 */
export function themeCouplets(theme: ThemeId): readonly Couplet[] {
  return COUPLETS[theme]
}

/**
 * 按字数筛选。
 *
 * @param list 对联列表
 * @param len 字数；0 或不传表示不筛
 * @returns 筛选后的列表
 * @example filterByLength(list, 7)
 */
export function filterByLength(list: readonly Couplet[], len = 0): Couplet[] {
  return len > 0 ? list.filter((p) => [...p.up].length === len) : list.slice()
}

/**
 * 随机选一副；传入 exclude 时尽量不选同一副（只有一副时没办法）。
 *
 * @param list 候选
 * @param exclude 要避开的当前这副
 * @param src 随机源，默认密码学随机，测试可注入
 * @returns 一副对联；候选为空返回 null
 * @example const next = randomCouplet(list, current)
 */
export function randomCouplet(list: readonly Couplet[], exclude?: Couplet | null, src?: RandomSource): Couplet | null {
  if (!list.length) return null
  const rest = exclude ? list.filter((p) => p.up !== exclude.up) : list
  return pick(rest.length ? rest : list, src)
}

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

/** 全部主题编号，便于遍历 */
export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id)
