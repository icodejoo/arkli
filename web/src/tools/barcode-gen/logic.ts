// 条形码：EAN-13 / Code128（B 集）/ Code39 编码成模块串，并按模块画到 Canvas
// 模块串由 '1'（黑条）和 '0'（空白）组成，每个字符占 1 个模块宽

/** 条码类型 */
export type BarcodeKind = 'ean13' | 'code128' | 'code39'

/** 类型选项 */
export const BARCODE_KINDS: ReadonlyArray<{ id: BarcodeKind; label: string; hint: string }> = [
  { id: 'ean13', label: 'EAN-13', hint: '输入 12 位数字自动补校验位；输入 13 位会校验末位' },
  { id: 'code128', label: 'Code128', hint: '支持可见 ASCII 字符（B 集），自动算校验' },
  { id: 'code39', label: 'Code39', hint: '支持 0-9、A-Z、空格与 - . $ / + %，小写会转大写' },
]

/** 编码结果 */
export type EncodeResult = { ok: true; modules: string; label: string } | { ok: false; error: string }

/** EAN 左侧 L 码 */
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
/** EAN 左侧 G 码 */
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
/** EAN 右侧 R 码（L 码取反） */
const EAN_R = EAN_L.map((c) => [...c].map((b) => (b === '1' ? '0' : '1')).join(''))
/** 首位数字决定左侧 6 位用 L 还是 G */
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']
/** EAN 起止护线、中间护线 */
const EAN_GUARD = '101'
const EAN_MIDDLE = '01010'

/**
 * 计算 EAN-13 校验位。
 * @param d12 前 12 位数字
 * @returns 校验位 0~9
 * @example eanCheckDigit('590123412345') // 7
 */
export function eanCheckDigit(d12: string): number {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}

/**
 * EAN-13 编码。
 * @param text 12 或 13 位数字
 * @returns 95 个模块的模块串与完整 13 位文字
 * @example encodeEan13('590123412345') // label '5901234123457'
 */
export function encodeEan13(text: string): EncodeResult {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return { ok: false, error: t ? 'EAN-13 只能输入数字' : '请输入 12 位数字' }
  if (t.length !== 12 && t.length !== 13) return { ok: false, error: `需要 12 位（自动补校验位）或 13 位，当前 ${t.length} 位` }
  const check = eanCheckDigit(t.slice(0, 12))
  if (t.length === 13 && Number(t[12]) !== check) return { ok: false, error: `校验位不对，第 13 位应为 ${check}` }
  const full = t.slice(0, 12) + check
  const parity = EAN_PARITY[Number(full[0])]
  let m = EAN_GUARD
  for (let i = 0; i < 6; i++) m += (parity[i] === 'L' ? EAN_L : EAN_G)[Number(full[i + 1])]
  m += EAN_MIDDLE
  for (let i = 7; i < 13; i++) m += EAN_R[Number(full[i])]
  return { ok: true, modules: m + EAN_GUARD, label: full }
}

/** Code128 各符号的条空宽度（6 位一组，条空交替），下标即符号值 0~105 */
export const CODE128_PATTERNS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232'
).split(' ')
/** Code128 起始符 B 的符号值 */
const C128_START_B = 104
/** Code128 终止符宽度（7 位，含结尾条） */
const C128_STOP = '2331112'
/** B 集可编码的 ASCII 范围 */
const C128_MIN = 32
const C128_MAX = 126
/** 模块串转换：把条空宽度串展开为 1/0 */
function runsToModules(widths: string): string {
  let out = ''
  let bar = true
  for (const w of widths) {
    out += (bar ? '1' : '0').repeat(Number(w))
    bar = !bar
  }
  return out
}

/**
 * Code128（B 集）编码。
 * @param text 可见 ASCII 文本
 * @returns 模块串与原文
 * @example encodeCode128('Hello')
 */
export function encodeCode128(text: string): EncodeResult {
  if (!text) return { ok: false, error: '请输入内容' }
  const codes: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c < C128_MIN || c > C128_MAX) return { ok: false, error: `Code128 B 集不支持字符 "${ch}"，只能用可见 ASCII 字符` }
    codes.push(c - C128_MIN)
  }
  let sum = C128_START_B
  codes.forEach((v, i) => (sum += v * (i + 1)))
  const symbols = [C128_START_B, ...codes, sum % 103]
  const widths = symbols.map((s) => CODE128_PATTERNS[s]).join('') + C128_STOP
  return { ok: true, modules: runsToModules(widths), label: text }
}

/** Code39 每个字符里 3 条宽元素的位置（1~9，条空交替，从条开始） */
export const CODE39_WIDE: Readonly<Record<string, readonly number[]>> = {
  '0': [4, 5, 7], '1': [1, 4, 9], '2': [3, 4, 9], '3': [1, 3, 4], '4': [4, 5, 9],
  '5': [1, 4, 5], '6': [3, 4, 5], '7': [4, 7, 9], '8': [1, 4, 7], '9': [3, 4, 7],
  A: [1, 6, 9], B: [3, 6, 9], C: [1, 3, 6], D: [5, 6, 9], E: [1, 5, 6],
  F: [3, 5, 6], G: [6, 7, 9], H: [1, 6, 7], I: [3, 6, 7], J: [5, 6, 7],
  K: [1, 8, 9], L: [3, 8, 9], M: [1, 3, 8], N: [5, 8, 9], O: [1, 5, 8],
  P: [3, 5, 8], Q: [7, 8, 9], R: [1, 7, 8], S: [3, 7, 8], T: [5, 7, 8],
  U: [1, 2, 9], V: [2, 3, 9], W: [1, 2, 3], X: [2, 5, 9], Y: [1, 2, 5], Z: [2, 3, 5],
  '-': [2, 7, 9], '.': [1, 2, 7], ' ': [2, 3, 7], '*': [2, 5, 7],
  $: [2, 4, 6], '/': [2, 4, 8], '+': [2, 6, 8], '%': [4, 6, 8],
}
/** Code39 宽元素与窄元素的模块比 */
const C39_WIDE_RATIO = 3

/** 单个 Code39 字符转模块串（9 个元素，条空交替） */
function code39Char(ch: string): string {
  const wide = CODE39_WIDE[ch]
  let out = ''
  for (let i = 1; i <= 9; i++) out += (i % 2 === 1 ? '1' : '0').repeat(wide.includes(i) ? C39_WIDE_RATIO : 1)
  return out
}

/**
 * Code39 编码（自动加首尾 * 起止符）。
 * @param text 文本，小写自动转大写
 * @returns 模块串与大写后的文本
 * @example encodeCode39('ABC-123')
 */
export function encodeCode39(text: string): EncodeResult {
  const t = text.toUpperCase()
  if (!t) return { ok: false, error: '请输入内容' }
  for (const ch of t) {
    if (ch === '*' || !(ch in CODE39_WIDE)) return { ok: false, error: `Code39 不支持字符 "${ch}"` }
  }
  return { ok: true, modules: [...`*${t}*`].map(code39Char).join('0'), label: t }
}

/**
 * 按类型编码。
 * @param kind 条码类型
 * @param text 输入内容
 * @returns 编码结果或错误提示
 * @example encodeBarcode('ean13', '590123412345')
 */
export function encodeBarcode(kind: BarcodeKind, text: string): EncodeResult {
  if (kind === 'ean13') return encodeEan13(text)
  if (kind === 'code128') return encodeCode128(text)
  return encodeCode39(text)
}

/** 绘制选项 */
export interface DrawOptions {
  /** 每模块像素数（整数，保证条纹边缘清晰） */
  scale: number
  /** 条高（像素） */
  barHeight: number
  /** 是否在下方显示文字 */
  showText: boolean
  /** 前景色 */
  fg: string
  /** 背景色 */
  bg: string
}

/** 两侧静区（模块数） */
export const QUIET_MODULES = 10
/** 文字区高度（像素） */
export const TEXT_HEIGHT = 28
/** 条高范围 */
export const BAR_HEIGHT_MIN = 40
export const BAR_HEIGHT_MAX = 240
/** 每模块像素范围 */
export const SCALE_MIN = 1
export const SCALE_MAX = 6
/** 默认颜色 */
export const DEFAULT_FG = '#000000'
export const DEFAULT_BG = '#ffffff'

/** 最小绘图上下文（便于单测用假对象） */
export interface BarCtx {
  fillStyle: string | CanvasGradient | CanvasPattern
  fillRect(x: number, y: number, w: number, h: number): void
  font?: string
  textAlign?: CanvasTextAlign
  textBaseline?: CanvasTextBaseline
  fillText?(text: string, x: number, y: number): void
}

/**
 * 计算画布尺寸。
 * @param moduleCount 模块总数
 * @param o 绘制选项
 * @returns 宽高（像素）
 * @example layoutBarcode(95, opts)
 */
export function layoutBarcode(moduleCount: number, o: DrawOptions): { width: number; height: number } {
  return {
    width: (moduleCount + QUIET_MODULES * 2) * o.scale,
    height: o.barHeight + (o.showText ? TEXT_HEIGHT : 0) + QUIET_MODULES,
  }
}

/**
 * 把条码画到画布（画布宽高需先按 layoutBarcode 设好）。
 * @param ctx 2D 上下文
 * @param enc 编码成功的结果
 * @param o 绘制选项
 * @returns 画布宽高
 * @example drawBarcode(canvas.getContext('2d')!, enc, opts)
 */
export function drawBarcode(ctx: BarCtx, enc: { modules: string; label: string }, o: DrawOptions): { width: number; height: number } {
  const size = layoutBarcode(enc.modules.length, o)
  ctx.fillStyle = o.bg
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.fillStyle = o.fg
  const top = QUIET_MODULES / 2
  let i = 0
  while (i < enc.modules.length) {
    if (enc.modules[i] !== '1') {
      i++
      continue
    }
    let j = i
    while (j < enc.modules.length && enc.modules[j] === '1') j++
    ctx.fillRect((QUIET_MODULES + i) * o.scale, top, (j - i) * o.scale, o.barHeight)
    i = j
  }
  if (o.showText && ctx.fillText) {
    ctx.font = '20px ui-monospace, Menlo, Consolas, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(enc.label, size.width / 2, top + o.barHeight + TEXT_HEIGHT / 2)
  }
  return size
}
