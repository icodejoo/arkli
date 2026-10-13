// 金额转大写：全程用字符串与 BigInt 运算，不经过浮点

/** 大写数字 0 到 9 */
const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
/** 组内位权：个位无单位，其后是 拾、佰、仟 */
const SMALL_UNITS = ['', '拾', '佰', '仟']
/** 组权：个、万、亿（每组四位） */
const GROUP_UNITS = ['', '万', '亿']
/** 整数部分最多位数（到千亿） */
export const MAX_INT_DIGITS = 12
/** 零的写法 */
const ZERO = DIGITS[0]
/** 每元的分数 */
const FEN_PER_YUAN = 100n

/** 转换结果：成功带大写文本，失败带中文提示 */
export type MoneyResult = { ok: true; text: string } | { ok: false; error: string }

/**
 * 把 0 到 9999 的一组数字转成大写（不含组权），组内的零合并。
 *
 * @param n 0 到 9999 的整数
 * @returns 大写文本，n 为 0 时返回空串
 * @example sectionToUpper(1010) // '壹仟零壹拾'
 */
function sectionToUpper(n: number): string {
  const s = String(n).padStart(4, '0')
  let out = ''
  let pendingZero = false
  for (let i = 0; i < 4; i++) {
    const d = Number(s[i])
    if (d === 0) {
      pendingZero = true
      continue
    }
    if (pendingZero && out) out += ZERO
    pendingZero = false
    out += DIGITS[d] + SMALL_UNITS[3 - i]
  }
  return out
}

/**
 * 把非负整数（不超过 12 位）转成大写。
 *
 * @param n 非负 BigInt
 * @returns 大写文本，0 返回「零」
 * @example intToUpper(100010n) // '壹拾万零壹拾'
 */
export function intToUpper(n: bigint): string {
  if (n === 0n) return ZERO
  const groups: number[] = []
  let rest = n
  while (rest > 0n) {
    groups.push(Number(rest % 10000n))
    rest /= 10000n
  }
  let out = ''
  let zeroGap = false // 高位已有内容、中间整组为零
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]
    if (g === 0) {
      if (out) zeroGap = true
      continue
    }
    if (out && (zeroGap || g < 1000)) out += ZERO
    zeroGap = false
    out += sectionToUpper(g) + GROUP_UNITS[i]
  }
  return out
}

/**
 * 把金额文本解析成「分」。支持千分位逗号、空格、前导 ¥/￥、正负号；
 * 超过两位小数按四舍五入。
 *
 * @param text 用户输入
 * @returns 分（可为负）；非法时返回错误文本
 */
function parseToFen(text: string): { fen: bigint } | { error: string } {
  const cleaned = text.trim().replace(/[,，\s]/g, '').replace(/^([+-]?)[¥￥]/, '$1')
  if (!cleaned) return { error: '请输入金额' }
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(cleaned)
  if (!m || (!m[2] && !m[3])) return { error: '金额格式不对，只能包含数字和一个小数点' }
  const intPart = (m[2] || '0').replace(/^0+(?=\d)/, '')
  const frac = m[3] ?? ''
  let fen = BigInt(intPart) * FEN_PER_YUAN + BigInt((frac + '00').slice(0, 2))
  if (frac.length > 2 && frac.charCodeAt(2) >= 53) fen += 1n // 第三位 >= 5 进位
  if (fen >= 10n ** BigInt(MAX_INT_DIGITS + 2)) return { error: '金额太大，最多支持到千亿（12 位整数）' }
  return { fen: m[1] === '-' ? -fen : fen }
}

/**
 * 金额转中文大写。
 *
 * @param text 金额文本，如 `100,010.05`
 * @returns 成功时 `{ ok: true, text }`，失败时 `{ ok: false, error }`
 * @example
 * moneyToUpper('10.00') // { ok: true, text: '壹拾元整' }
 * moneyToUpper('0.5')   // { ok: true, text: '伍角' }
 */
export function moneyToUpper(text: string): MoneyResult {
  const parsed = parseToFen(text)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  const neg = parsed.fen < 0n
  const abs = neg ? -parsed.fen : parsed.fen
  const yuan = abs / FEN_PER_YUAN
  const jiao = Number((abs % FEN_PER_YUAN) / 10n)
  const fen = Number(abs % 10n)

  let out = yuan > 0n ? intToUpper(yuan) + '元' : ''
  if (jiao === 0 && fen === 0) {
    out = (out || ZERO + '元') + '整'
  } else {
    if (jiao > 0) out += DIGITS[jiao] + '角'
    else if (yuan > 0n) out += ZERO // 有元无角有分：壹元零伍分
    if (fen > 0) out += DIGITS[fen] + '分'
  }
  return { ok: true, text: (neg && abs > 0n ? '负' : '') + out }
}
