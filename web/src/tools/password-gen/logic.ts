// 密码生成器：无偏随机、每类至少一个、熵值估算
import { cryptoSource, pick, shuffle, type RandomSource } from '@/shared/random'

/** 长度范围 */
export const MIN_LENGTH = 4
export const MAX_LENGTH = 128
/** 批量个数范围 */
export const MIN_COUNT = 1
export const MAX_COUNT = 20

/** 各字符集 */
export const CHARSETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
} as const

/** 易混字符：数字 0/1 与字母 O/l/I */
export const AMBIGUOUS = '0O1lI'

/** 字符集类别 */
export type CharsetKey = keyof typeof CHARSETS

/** 生成选项 */
export interface PasswordOptions {
  /** 密码长度 */
  length: number
  /** 各字符集是否启用 */
  sets: Record<CharsetKey, boolean>
  /** 是否排除易混字符 */
  excludeAmbiguous: boolean
  /** 每个启用的字符集至少出现一次 */
  ensureEach: boolean
}

/** 强度等级 */
export type Strength = 'weak' | 'fair' | 'good' | 'strong'

/** 默认选项 */
export const DEFAULT_OPTIONS: PasswordOptions = {
  length: 16,
  sets: { upper: true, lower: true, digits: true, symbols: false },
  excludeAmbiguous: false,
  ensureEach: true,
}

/** 强度分界（bit）：低于 40 弱，低于 60 一般，低于 80 良好，其余强 */
const STRENGTH_BITS = [40, 60, 80]

/**
 * 按选项得到各启用字符集（已剔除易混字符，空集被丢掉）。
 *
 * @param opts 选项
 * @returns 字符集数组，每项是不重复的字符串
 * @example
 * activeSets(DEFAULT_OPTIONS).length // 3
 */
export function activeSets(opts: PasswordOptions): string[] {
  const keys = Object.keys(CHARSETS) as CharsetKey[]
  return keys
    .filter((k) => opts.sets[k])
    .map((k) => (opts.excludeAmbiguous ? [...CHARSETS[k]].filter((c) => !AMBIGUOUS.includes(c)).join('') : CHARSETS[k]))
    .filter((s) => s.length > 0)
}

/**
 * 校验选项。
 *
 * @param opts 选项
 * @returns 错误提示；通过时为 null
 * @example
 * validateOptions({ ...DEFAULT_OPTIONS, length: 2 }) // '长度需在 4 ~ 128 之间'
 */
export function validateOptions(opts: PasswordOptions): string | null {
  if (!Number.isInteger(opts.length) || opts.length < MIN_LENGTH || opts.length > MAX_LENGTH) {
    return `长度需在 ${MIN_LENGTH} ~ ${MAX_LENGTH} 之间`
  }
  const sets = activeSets(opts)
  if (sets.length === 0) return '至少选择一种字符类型'
  if (opts.ensureEach && opts.length < sets.length) return '长度小于字符类型数，无法每类至少一个'
  return null
}

/**
 * 生成一个密码。
 *
 * @param opts 选项
 * @param src 随机源
 * @returns 密码字符串
 * @throws RangeError 选项不合法（先用 validateOptions 检查）
 * @example
 * generatePassword(DEFAULT_OPTIONS) // 'aZ3kQ9...'
 */
export function generatePassword(opts: PasswordOptions, src: RandomSource = cryptoSource): string {
  const err = validateOptions(opts)
  if (err) throw new RangeError(err)
  const sets = activeSets(opts)
  const pool = [...sets.join('')]
  const chars: string[] = opts.ensureEach ? sets.map((s) => pick([...s], src)) : []
  while (chars.length < opts.length) chars.push(pick(pool, src))
  // 必选字符放在前面，最后洗牌，避免位置规律
  return shuffle(chars, src).join('')
}

/**
 * 批量生成。
 *
 * @param opts 选项
 * @param count 个数（1 ~ 20）
 * @param src 随机源
 * @returns 密码列表
 * @throws RangeError 个数或选项不合法
 * @example
 * generateBatch(DEFAULT_OPTIONS, 3).length // 3
 */
export function generateBatch(opts: PasswordOptions, count: number, src: RandomSource = cryptoSource): string[] {
  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) throw new RangeError('个数需在 1 ~ 20 之间')
  return Array.from({ length: count }, () => generatePassword(opts, src))
}

/**
 * 估算熵值（bit）：长度 × log2(字符池大小)。开了“每类至少一个”会略低于此值，这里不扣。
 *
 * @param opts 选项
 * @returns 熵值；选项无可用字符时为 0
 * @example
 * entropyBits(DEFAULT_OPTIONS) // 约 95.3
 */
export function entropyBits(opts: PasswordOptions): number {
  const size = new Set(activeSets(opts).join('')).size
  return size > 0 ? opts.length * Math.log2(size) : 0
}

/**
 * 按熵值分级。
 *
 * @param bits 熵值
 * @returns 强度等级
 * @example
 * strengthOf(30) // 'weak'
 */
export function strengthOf(bits: number): Strength {
  if (bits < STRENGTH_BITS[0]) return 'weak'
  if (bits < STRENGTH_BITS[1]) return 'fair'
  if (bits < STRENGTH_BITS[2]) return 'good'
  return 'strong'
}
