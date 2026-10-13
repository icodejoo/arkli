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
