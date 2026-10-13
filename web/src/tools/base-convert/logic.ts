// 进制转换：BigInt 任意长整数，不支持小数

/** 最小进制 */
export const MIN_BASE = 2
/** 最大进制（0-9 加 a-z） */
export const MAX_BASE = 36
/** 可选补码位宽 */
export const BIT_WIDTHS = [8, 16, 32, 64] as const
/** 补码位宽类型 */
export type BitWidth = (typeof BIT_WIDTHS)[number]

/** 解析结果 */
export type ParseResult = { ok: true; value: bigint } | { ok: false; error: string }

/**
 * 当前环境是否支持 BigInt（老 WebView 可能没有）。
 *
 * @returns 支持返回 true
 */
export function supportsBigInt(): boolean {
  return typeof BigInt === 'function'
}

/**
 * 按指定进制解析整数文本。允许首位正负号、下划线与空格分隔，大小写不敏感。
 *
 * @param text 输入文本
 * @param base 进制，2 到 36
 * @returns 成功带 BigInt 值，失败带中文提示
 * @example parseInBase('ff', 16) // { ok: true, value: 255n }
 */
export function parseInBase(text: string, base: number): ParseResult {
  if (!Number.isInteger(base) || base < MIN_BASE || base > MAX_BASE) {
    return { ok: false, error: `进制要在 ${MIN_BASE} 到 ${MAX_BASE} 之间` }
  }
  const s = text.replace(/[\s_]/g, '')
  if (!s) return { ok: false, error: '请输入数字' }
  const neg = s[0] === '-'
  const body = s[0] === '-' || s[0] === '+' ? s.slice(1) : s
  if (!body) return { ok: false, error: '只有符号，没有数字' }
  const big = BigInt(base)
  let value = 0n
  for (const ch of body) {
    const d = /^[0-9a-zA-Z]$/.test(ch) ? parseInt(ch, 36) : NaN
    if (Number.isNaN(d) || d >= base) return { ok: false, error: `「${ch}」不是 ${base} 进制的数字` }
    value = value * big + BigInt(d)
  }
  return { ok: true, value: neg ? -value : value }
}

/**
 * 把整数格式化为指定进制（字母大写）。
 *
 * @param value BigInt 整数
 * @param base 进制，2 到 36
 * @returns 文本，负数带负号
 * @example formatInBase(255n, 16) // 'FF'
 */
export function formatInBase(value: bigint, base: number): string {
  return value.toString(base).toUpperCase()
}

/**
 * 求某位宽下的二进制补码。
 *
 * @param value 整数
 * @param bits 位宽
 * @returns 补码的二进制文本（补满位宽）；超出位宽可表示范围 [-2^(n-1), 2^n-1] 时返回 null
 * @example twosComplement(-1n, 8) // '11111111'
 */
export function twosComplement(value: bigint, bits: BitWidth): string | null {
  const b = BigInt(bits)
  if (value < -(1n << (b - 1n)) || value >= 1n << b) return null
  const unsigned = value < 0n ? value + (1n << b) : value
  return unsigned.toString(2).padStart(bits, '0')
}

/** 四种常用进制 */
export const COMMON_BASES = [2, 8, 10, 16] as const
