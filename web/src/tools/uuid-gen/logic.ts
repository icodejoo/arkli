// UUID / NanoID 批量生成，随机源统一用 crypto.getRandomValues

/** 生成类型 */
export type IdKind = 'uuid4' | 'uuid7' | 'nanoid'

/** 类型选项与显示名 */
export const ID_KINDS: ReadonlyArray<{ id: IdKind; label: string }> = [
  { id: 'uuid4', label: 'UUID v4' },
  { id: 'uuid7', label: 'UUID v7' },
  { id: 'nanoid', label: 'NanoID' },
]

/** NanoID 默认字符集（与官方一致） */
export const NANOID_DEFAULT_ALPHABET = '_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** NanoID 默认长度 */
export const NANOID_DEFAULT_SIZE = 21
/** NanoID 长度范围 */
export const NANOID_SIZE_MIN = 1
export const NANOID_SIZE_MAX = 128
/** 单次批量上限 */
export const BATCH_MAX = 500
/** 一次 getRandomValues 最多 65536 字节 */
const RANDOM_CHUNK = 65536
/** UUID 版本位与变体位 */
const VERSION_4 = 0x40
const VERSION_7 = 0x70
const VARIANT_RFC = 0x80

/** 随机源：把传入数组填满随机字节 */
export type RandomFill = (buf: Uint8Array) => Uint8Array

/** 默认随机源（分块以避开 65536 字节上限） */
export const defaultRandom: RandomFill = (buf) => {
  for (let i = 0; i < buf.length; i += RANDOM_CHUNK) crypto.getRandomValues(buf.subarray(i, i + RANDOM_CHUNK))
  return buf
}

/** 16 字节转 8-4-4-4-12 小写 hex */
function formatUuid(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * 生成 UUID v4。
 * @param rnd 随机源，默认 crypto
 * @returns 36 位小写 UUID
 * @example uuidV4() // '3b241101-e2bb-4255-8caf-4136c566a962'
 */
export function uuidV4(rnd: RandomFill = defaultRandom): string {
  const b = rnd(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | VERSION_4
  b[8] = (b[8] & 0x3f) | VARIANT_RFC
  return formatUuid(b)
}

/**
 * 生成 UUID v7（前 48 位为毫秒时间戳，可按时间排序）。
 * @param now 毫秒时间戳，默认当前时间
 * @param rnd 随机源，默认 crypto
 * @returns 36 位小写 UUID
 * @example uuidV7(1700000000000)
 */
export function uuidV7(now: number = Date.now(), rnd: RandomFill = defaultRandom): string {
  const b = rnd(new Uint8Array(16))
  let t = Math.floor(now)
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256
    t = Math.floor(t / 256)
  }
  b[6] = (b[6] & 0x0f) | VERSION_7
  b[8] = (b[8] & 0x3f) | VARIANT_RFC
  return formatUuid(b)
}

/**
 * 生成 NanoID（拒绝采样，无取模偏差）。
 * @param size 长度
 * @param alphabet 字符集（1~256 个字符）
 * @param rnd 随机源，默认 crypto
 * @returns 随机串
 * @example nanoid(10, 'abc123')
 */
export function nanoid(size: number, alphabet: string = NANOID_DEFAULT_ALPHABET, rnd: RandomFill = defaultRandom): string {
  const chars = Array.from(new Set(alphabet))
  const n = chars.length
  // 小于 2 的幂的最小掩码，超出范围的字节丢弃重抽
  const mask = (2 << Math.floor(Math.log2(n - 1 || 1))) - 1
  let out = ''
  while (out.length < size) {
    const bytes = rnd(new Uint8Array(Math.ceil((size - out.length) * 1.6) + 8))
    for (const x of bytes) {
      const v = x & mask
      if (v < n) {
        out += chars[v]
        if (out.length === size) break
      }
    }
  }
  return out
}

/** 生成选项 */
export interface GenOptions {
  kind: IdKind
  count: number
  size: number
  alphabet: string
  upper: boolean
  /** UUID 是否去掉连字符 */
  noDash: boolean
}

/**
 * 校验选项，返回错误提示；合法返回空串。
 * @param o 生成选项
 * @returns 错误文案或空串
 * @example validateOptions({ kind: 'nanoid', count: 1, size: 0, alphabet: 'a', upper: false, noDash: false })
 */
export function validateOptions(o: GenOptions): string {
  if (!Number.isInteger(o.count) || o.count < 1 || o.count > BATCH_MAX) return `数量需在 1~${BATCH_MAX} 之间`
  if (o.kind === 'nanoid') {
    if (!Number.isInteger(o.size) || o.size < NANOID_SIZE_MIN || o.size > NANOID_SIZE_MAX) {
      return `长度需在 ${NANOID_SIZE_MIN}~${NANOID_SIZE_MAX} 之间`
    }
    const n = new Set(o.alphabet).size
    if (n < 2) return '字符集至少要 2 个不同字符'
    if (n > 256) return '字符集最多 256 个不同字符'
  }
  return ''
}

/**
 * 按选项批量生成。
 * @param o 生成选项（需先通过 validateOptions）
 * @param rnd 随机源
 * @param now 时间戳（v7 用）
 * @returns ID 列表
 * @example generateIds({ kind: 'uuid4', count: 3, size: 21, alphabet: '', upper: false, noDash: false })
 */
export function generateIds(o: GenOptions, rnd: RandomFill = defaultRandom, now: number = Date.now()): string[] {
  const list: string[] = []
  for (let i = 0; i < o.count; i++) {
    let id: string
    if (o.kind === 'uuid4') id = uuidV4(rnd)
    else if (o.kind === 'uuid7') id = uuidV7(now, rnd)
    else id = nanoid(o.size, o.alphabet, rnd)
    if (o.kind !== 'nanoid') {
      if (o.noDash) id = id.replace(/-/g, '')
      if (o.upper) id = id.toUpperCase()
    }
    list.push(id)
  }
  return list
}
