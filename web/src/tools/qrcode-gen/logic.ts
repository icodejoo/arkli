// 二维码生成：封装 nayuki qrcodegen 取模块矩阵，并提供可注入的绘制与颜色检查
import { qrcodegen } from '@/vendor/qrcodegen'

/** 纠错等级 */
export type EccLevel = 'L' | 'M' | 'Q' | 'H'

/** 纠错等级选项（含大致恢复能力说明） */
export const ECC_OPTIONS: ReadonlyArray<{ id: EccLevel; label: string; hint: string }> = [
  { id: 'L', label: 'L', hint: '约 7%' },
  { id: 'M', label: 'M', hint: '约 15%' },
  { id: 'Q', label: 'Q', hint: '约 25%' },
  { id: 'H', label: 'H', hint: '约 30%' },
]

/** 边距下限（单位：模块） */
export const BORDER_MIN = 0
/** 边距上限（单位：模块） */
export const BORDER_MAX = 10
/** 输出像素边长下限 */
export const SIZE_MIN = 128
/** 输出像素边长上限 */
export const SIZE_MAX = 1024

/** 默认前景色 */
export const DEFAULT_FG = '#000000'
/** 默认背景色 */
export const DEFAULT_BG = '#ffffff'

/** 超出容量时的提示 */
const TOO_LONG_MSG = '内容太长，超出二维码容量。可以降低纠错等级，或缩短内容后再试'

/** 扫码可读性所需的最低对比度 */
const MIN_CONTRAST = 3

/** 各纠错等级对应的库枚举 */
const ECC_MAP: Record<EccLevel, qrcodegen.QrCode.Ecc> = {
  L: qrcodegen.QrCode.Ecc.LOW,
  M: qrcodegen.QrCode.Ecc.MEDIUM,
  Q: qrcodegen.QrCode.Ecc.QUARTILE,
  H: qrcodegen.QrCode.Ecc.HIGH,
}

/** 生成结果：模块矩阵与元信息 */
export interface QrMatrix {
  /** 边长（模块数，不含边距） */
  size: number
  /** 版本 1~40 */
  version: number
  /** 实际采用的纠错等级（不自动升级） */
  ecc: EccLevel
  /** 行优先矩阵，true 为深色模块 */
  modules: boolean[][]
}

/** 生成结果：成功带矩阵，失败带中文提示 */
export type QrResult = { ok: true; value: QrMatrix } | { ok: false; error: string }

/**
 * 把文本编码为二维码模块矩阵（自动选最小版本，不擅自提高纠错等级）。
 *
 * @param text 要编码的文本，空串返回错误
 * @param ecc 纠错等级
 * @returns 成功返回矩阵；空内容或超出容量返回中文错误
 * @example
 * const r = makeQr('https://example.com', 'M')
 * if (r.ok) console.log(r.value.size, r.value.version)
 */
export function makeQr(text: string, ecc: EccLevel): QrResult {
  if (!text) return { ok: false, error: '请输入要生成二维码的内容' }
  try {
    const qr = qrcodegen.QrCode.encodeSegments(qrcodegen.QrSegment.makeSegments(text), ECC_MAP[ecc], 1, 40, -1, false)
    const modules: boolean[][] = []
    for (let y = 0; y < qr.size; y++) {
      const row: boolean[] = []
      for (let x = 0; x < qr.size; x++) row.push(qr.getModule(x, y))
      modules.push(row)
    }
    return { ok: true, value: { size: qr.size, version: qr.version, ecc, modules } }
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, error: TOO_LONG_MSG }
    throw e
  }
}

/** 最小绘图接口（CanvasRenderingContext2D 满足），便于测试注入 */
export interface DrawTarget {
  /** 填充色 */
  fillStyle: string | CanvasGradient | CanvasPattern
  /** 填充矩形 */
  fillRect(x: number, y: number, w: number, h: number): void
}

/** 渲染参数 */
export interface RenderOptions {
  /** 目标边长（像素），实际取模块整数倍，不超过它 */
  size: number
  /** 边距（模块数） */
  border: number
  /** 前景色 */
  fg: string
  /** 背景色 */
  bg: string
}

/**
 * 计算整数缩放：每个模块占几个像素，以及画布实际边长。
 *
 * @param modules 模块数（不含边距）
 * @param opts 渲染参数
 * @returns 每模块像素与画布边长；目标太小时每模块至少 1 像素
 * @example
 * layout(21, { size: 256, border: 4, fg: '#000', bg: '#fff' }) // { scale: 8, pixels: 232 }
 */
export function layout(modules: number, opts: RenderOptions): { scale: number; pixels: number } {
  const total = modules + opts.border * 2
  const scale = Math.max(1, Math.floor(opts.size / total))
  return { scale, pixels: scale * total }
}

/**
 * 把矩阵画到绘图目标上（先铺满背景，再逐个画深色模块）。
 *
 * @param target 绘图目标
 * @param qr 模块矩阵
 * @param opts 渲染参数
 * @returns 实际画布边长（像素），调用方据此设置 canvas 宽高
 */
export function drawQr(target: DrawTarget, qr: QrMatrix, opts: RenderOptions): number {
  const { scale, pixels } = layout(qr.size, opts)
  target.fillStyle = opts.bg
  target.fillRect(0, 0, pixels, pixels)
  target.fillStyle = opts.fg
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) target.fillRect((x + opts.border) * scale, (y + opts.border) * scale, scale, scale)
    }
  }
  return pixels
}

/**
 * 把 #rgb / #rrggbb 解析为 RGB 三元组。
 *
 * @param color 颜色字符串
 * @returns [r, g, b]，格式非法返回 null
 */
export function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** 相对亮度（sRGB，0~1） */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/**
 * 检查前景/背景是否容易扫不出：对比度过低，或前景比背景亮（反色码，部分扫码器不识别）。
 *
 * @param fg 前景色 hex
 * @param bg 背景色 hex
 * @returns 提示文案；没问题或颜色非法返回空串
 * @example
 * colorWarning('#cccccc', '#ffffff') // '前景和背景对比度太低，可能扫不出来'
 */
export function colorWarning(fg: string, bg: string): string {
  const f = parseHex(fg)
  const b = parseHex(bg)
  if (!f || !b) return ''
  const lf = luminance(f)
  const lb = luminance(b)
  if (lf > lb) return '前景比背景亮（反色码），部分扫码器识别不了'
  return (lb + 0.05) / (lf + 0.05) < MIN_CONTRAST ? '前景和背景对比度太低，可能扫不出来' : ''
}

/** logo 边长占码边长（模块数，不含静区）的百分比下限 */
export const LOGO_PCT_MIN = 10
/** logo 默认占比（%，占码边长） */
export const LOGO_PCT_DEFAULT = 20
/** logo 底板内留白占底板边长的比例（落到模块网格上取整） */
export const LOGO_PAD_RATIO = 0.12
/** 安全上限判据：被盖码字在最差纠错块里的数量 ÷ 该块纠错上限 不得超过此值，留余量给污损和倾斜 */
const LOGO_SAFE_FACTOR = 0.5
/** 底板小于这个模块数就没有放 logo 的意义，视为该组合不适合 */
export const LOGO_MIN_USEFUL_MODULES = 3
/** 内容超过这个字符数视为长内容：码更密，放 logo 更难扫 */
export const LONG_TEXT_CHARS = 120
/** 放 logo 时建议的最低纠错等级 */
const LOGO_MIN_ECC: EccLevel = 'Q'

/** 各纠错等级在码表里的行号（顺序 L、M、Q、H） */
const ECC_ROW: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 }

/**
 * 每个纠错块的纠错码字数，下标 [纠错行][版本]（0 号位占位）。
 * 来源：QR 规范表，与 vendor/qrcodegen.ts 的 ECC_CODEWORDS_PER_BLOCK 一致（那份是 private，无法引用）。
 */
const ECC_CODEWORDS_PER_BLOCK: ReadonlyArray<ReadonlyArray<number>> = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]
/** 纠错块数，下标 [纠错行][版本]。来源同上（NUM_ERROR_CORRECTION_BLOCKS） */
const NUM_ERROR_CORRECTION_BLOCKS: ReadonlyArray<ReadonlyArray<number>> = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

/** 矩形（像素） */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 某版本的码字布局：每个模块所属码字序号与功能图案标记 */
interface CodewordLayout {
  /** 边长（模块数） */
  n: number
  /** 行优先，每个模块所属码字序号；功能图案与余位为 -1 */
  index: Int32Array
  /** 行优先，1 表示功能图案（定位、校正、时序、格式/版本信息） */
  func: Uint8Array
  /** 数据+纠错码字总数 */
  raw: number
}

/** 版本号 → 码字布局缓存 */
const layoutCache = new Map<number, CodewordLayout>()

/** 校正图案中心坐标（按 QR 规范），版本 1 无 */
function alignPositions(version: number): number[] {
  if (version === 1) return []
  const cnt = Math.floor(version / 7) + 2
  const size = version * 4 + 17
  const step = version === 32 ? 26 : Math.floor((version * 4 + cnt * 2 + 1) / (cnt * 2 - 2)) * 2
  const res = [6]
  for (let i = 0; i < cnt - 1; i++) res.push(size - 7 - (cnt - 2 - i) * step)
  return res
}

/** 把矩形区域标成功能图案 */
function markRect(func: Uint8Array, n: number, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) func[y * n + x] = 1
}

/** 取（并缓存）某版本的码字布局；蛇形走位与 QR 规范一致 */
function codewordLayout(version: number): CodewordLayout {
  const hit = layoutCache.get(version)
  if (hit) return hit
  const n = version * 4 + 17
  const func = new Uint8Array(n * n)
  markRect(func, n, 0, 0, 9, 9)
  markRect(func, n, n - 8, 0, 8, 9)
  markRect(func, n, 0, n - 8, 9, 8)
  markRect(func, n, 0, 6, n, 1)
  markRect(func, n, 6, 0, 1, n)
  const ap = alignPositions(version)
  ap.forEach((a, i) => {
    ap.forEach((b, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)
      if (!corner) markRect(func, n, b - 2, a - 2, 5, 5)
    })
  })
  if (version >= 7) {
    markRect(func, n, 0, n - 11, 6, 3)
    markRect(func, n, n - 11, 0, 3, 6)
  }
  const index = new Int32Array(n * n).fill(-1)
  let bit = 0
  let up = true
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < n; vert++) {
      const y = up ? n - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const x = right - j
        if (!func[y * n + x]) index[y * n + x] = bit++
      }
    }
    up = !up
  }
  const raw = Math.floor(bit / 8)
  for (let i = 0; i < index.length; i++) {
    if (index[i] >= 0) {
      index[i] = Math.floor(index[i] / 8)
      if (index[i] >= raw) index[i] = -1
    }
  }
  const lay = { n, index, func, raw }
  layoutCache.set(version, lay)
  return lay
}

/** 交错后每个码字所属的纠错块号（数据码字在前，纠错码字在后），并带回每块纠错码字数 */
function blockOfCodeword(version: number, ecc: EccLevel): { owner: number[]; eccPerBlock: number } {
  const row = ECC_ROW[ecc]
  const nb = NUM_ERROR_CORRECTION_BLOCKS[row][version]
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[row][version]
  const raw = codewordLayout(version).raw
  const shortCount = nb - (raw % nb)
  const shortLen = Math.floor(raw / nb)
  const dataLens: number[] = []
  for (let i = 0; i < nb; i++) dataLens.push(shortLen - eccPerBlock + (i < shortCount ? 0 : 1))
  const owner: number[] = []
  const maxLen = Math.max(...dataLens)
  for (let i = 0; i < maxLen; i++) for (let b = 0; b < nb; b++) if (i < dataLens[b]) owner.push(b)
  for (let i = 0; i < eccPerBlock; i++) for (let b = 0; b < nb; b++) owner.push(b)
  return { owner, eccPerBlock }
}

/** 居中盖住 k×k 模块时的损伤统计 */
export interface LogoHit {
  /** 被盖码字落在最差纠错块里的数量 */
  worst: number
  /** 该块纠错上限（每块纠错码字数 ÷ 2，向下取整） */
  limit: number
}

/**
 * 统计居中盖住 k×k 模块会损伤多少码字。
 *
 * @param version 版本 1~40
 * @param ecc 纠错等级
 * @param k logo 底板边长（模块数）
 * @returns 最差块被盖数、该块纠错上限
 * @example
 * logoHit(4, 'M', 5) // { worst: 4, limit: 9 }
 */
export function logoHit(version: number, ecc: EccLevel, k: number): LogoHit {
  const lay = codewordLayout(version)
  const { owner, eccPerBlock } = blockOfCodeword(version, ecc)
  const a = Math.floor((lay.n - k) / 2)
  const covered = new Set<number>()
  for (let y = a; y < a + k; y++) {
    for (let x = a; x < a + k; x++) {
      const cw = lay.index[y * lay.n + x]
      if (cw >= 0) covered.add(cw)
    }
  }
  const perBlock = new Map<number, number>()
  let worst = 0
  covered.forEach((cw) => {
    const c = (perBlock.get(owner[cw]) || 0) + 1
    perBlock.set(owner[cw], c)
    if (c > worst) worst = c
  })
  return { worst, limit: Math.floor(eccPerBlock / 2) }
}

/** 版本+纠错 → 安全上限缓存 */
const maxModulesCache = new Map<string, number>()

/**
 * 该版本、纠错等级下 logo 底板的最大安全边长（奇数个模块，居中，不含静区）。
 * 判据：被盖码字在最差纠错块的数量 ≤ 该块纠错上限的 50%（中心校正图案被盖不额外限制，与实验结论一致）。
 * 说明：纠错按码字计而非面积；logo 颜色越深、饱和度越高，对解码越不利，浅色或贴近背景更稳。
 *
 * @param version 版本 1~40
 * @param ecc 纠错等级
 * @returns 最大模块数（奇数）；连 1 个模块都不安全时返回 0
 * @example
 * logoMaxModules(4, 'H') // 7
 */
export function logoMaxModules(version: number, ecc: EccLevel): number {
  const key = `${version}${ecc}`
  const cached = maxModulesCache.get(key)
  if (cached !== undefined) return cached
  const n = version * 4 + 17
  let best = 0
  for (let k = 1; k < n - 8; k += 2) {
    const h = logoHit(version, ecc, k)
    if (h.worst <= LOGO_SAFE_FACTOR * h.limit) best = k
    else break
  }
  maxModulesCache.set(key, best)
  return best
}

/** logo 尺寸方案 */
export interface LogoPlan {
  /** 实际底板边长（奇数个模块） */
  modules: number
  /** 实际占码边长百分比（取整，不含静区） */
  pct: number
  /** 当前版本和纠错下的安全上限（模块数） */
  maxModules: number
  /** 滑块上限（%，向上取整，保证能拉到 maxModules） */
  maxPct: number
  /** 用户想要的占比超过上限，已自动缩小 */
  shrunk: boolean
  /** 该组合太小放不下有意义的 logo，不应绘制 */
  unfit: boolean
}

/**
 * 把用户想要的占比换算成模块网格上的 logo 方案，并按安全上限收缩。
 *
 * @param version 版本
 * @param size 码边长（模块数，不含静区）
 * @param ecc 纠错等级
 * @param wantPct 用户想要的占码边长百分比
 * @returns 实际模块数（奇数）、占比、上限及是否缩小/不适合
 * @example
 * resolveLogo(4, 33, 'H', 20) // { modules: 7, pct: 21, maxModules: 7, ... }
 */
export function resolveLogo(version: number, size: number, ecc: EccLevel, wantPct: number): LogoPlan {
  const maxModules = logoMaxModules(version, ecc)
  const maxPct = Math.ceil((maxModules / size) * 100)
  let want = Math.round((size * wantPct) / 100)
  if (want % 2 === 0) want -= 1
  want = Math.max(1, want)
  const modules = Math.min(want, maxModules)
  return {
    modules,
    pct: Math.round((modules / size) * 100),
    maxModules,
    maxPct,
    shrunk: wantPct > maxPct,
    unfit: maxModules < LOGO_MIN_USEFUL_MODULES,
  }
}

/** logo 底板与图片可用区域（像素） */
export interface LogoRects {
  /** 底板：背景色整格覆盖 */
  plate: Box
  /** 图片可用区：底板内按留白收缩 */
  inner: Box
}

/**
 * 计算对齐模块网格的 logo 底板：奇数个模块、居中、整格覆盖；图片在底板内留白。
 *
 * @param size 码边长（模块数，不含静区）
 * @param border 静区（模块数）
 * @param scale 每模块像素
 * @param modules 底板边长（奇数模块数）
 * @returns 底板与图片可用区的像素矩形
 * @example
 * logoRects(33, 4, 8, 7).plate // { x: 136, y: 136, w: 56, h: 56 }
 */
export function logoRects(size: number, border: number, scale: number, modules: number): LogoRects {
  const off = Math.floor((size - modules) / 2)
  const px = (border + off) * scale
  const plate = { x: px, y: px, w: modules * scale, h: modules * scale }
  const pad = Math.round(modules * LOGO_PAD_RATIO) * scale
  return { plate, inner: { x: px + pad, y: px + pad, w: plate.w - pad * 2, h: plate.h - pad * 2 } }
}

/**
 * 把图片按比例缩放装进方框（contain），并居中。
 *
 * @param iw 图片宽
 * @param ih 图片高
 * @param box 目标方框
 * @returns 图片实际绘制矩形；宽高非正返回方框本身
 */
export function fitContain(iw: number, ih: number, box: Box): Box {
  if (iw <= 0 || ih <= 0) return box
  const k = Math.min(box.w / iw, box.h / ih)
  const w = iw * k
  const h = ih * k
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

/** 放 logo 时的提示与建议 */
export interface LogoAdvice {
  /** 纠错偏低的警告，没有则空串 */
  eccWarning: string
  /** 可一键升级到的纠错等级（不自动改） */
  upgrade: EccLevel[]
  /** 自动缩小的提示，没有则空串 */
  shrinkNote: string
  /** 该组合不适合放 logo 的提示，没有则空串 */
  unfitNote: string
  /** 内容过长的提示，没有则空串 */
  longNote: string
}

/**
 * 汇总放 logo 时该给用户的提示。只给建议，不改用户的选择。
 *
 * @param ecc 当前纠错等级
 * @param textLength 内容字符数
 * @param plan resolveLogo 的结果
 * @returns 各类提示文案和可升级的等级
 * @example
 * logoAdvice('M', 30, plan).upgrade // ['Q', 'H']
 */
export function logoAdvice(ecc: EccLevel, textLength: number, plan: LogoPlan): LogoAdvice {
  const isLong = textLength > LONG_TEXT_CHARS
  const low = ECC_ROW[ecc] < ECC_ROW[LOGO_MIN_ECC]
  const upgrade: EccLevel[] = low ? ['Q', 'H'] : isLong && ecc !== 'H' ? ['H'] : []
  return {
    eccWarning: low ? '放了中间图片，纠错选 L/M 扫码成功率会明显降低，建议至少 Q' : '',
    upgrade,
    shrinkNote: plan.shrunk && !plan.unfit ? `已缩小到 ${plan.pct}%，建议改用 Q/H 或缩短内容` : '',
    unfitNote: plan.unfit ? '当前内容长度和纠错等级下不适合放中间图片，请调高纠错等级或缩短内容' : '',
    longNote: isLong ? '内容较长，扫码成功率会下降，建议使用短链或去掉多余参数（纠错建议 H）' : '',
  }
}
