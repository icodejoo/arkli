// 随机数生成的纯逻辑：范围、个数、去重、排序、小数位数

import { cryptoSource, draw, randomInt, type RandomSource } from '@/shared/random'

/** 单次最多生成个数 */
export const MAX_COUNT = 1000
/** 小数位数上限 */
export const MAX_DECIMALS = 6
/** 不重复且取值空间不大于此值时，用洗牌抽取；更大时用集合拒绝重复 */
const SHUFFLE_LIMIT = 100000

/** 生成选项 */
export interface RandomOptions {
  /** 下界（含） */
  min: number
  /** 上界（含） */
  max: number
  /** 个数 */
  count: number
  /** 是否允许重复 */
  allowDuplicates: boolean
  /** 是否从小到大排序 */
  sort: boolean
  /** 小数位数，0 为整数 */
  decimals: number
}

/**
 * 生成一组随机数。小数按“放大成整数再拒绝采样”处理，所以每个取值等概率。
 *
 * @param opts 选项，min/max 会按小数位数四舍五入到可取值
 * @param src 随机源，默认密码学随机
 * @returns 数字数组（小数位数固定为 decimals，用 toFixed 格式化成字符串）
 * @throws RangeError 范围、个数、小数位数非法，或不重复时可取值不够
 * @example
 * generateNumbers({ min: 1, max: 6, count: 3, allowDuplicates: false, sort: true, decimals: 0 })
 * // ['2', '4', '5']
 */
export function generateNumbers(opts: RandomOptions, src: RandomSource = cryptoSource): string[] {
  const { min, max, count, allowDuplicates, sort, decimals } = opts
  if (![min, max, count, decimals].every(Number.isFinite)) throw new RangeError('参数不是有效数字')
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new RangeError(`个数要在 1 ~ ${MAX_COUNT} 之间`)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`小数位数要在 0 ~ ${MAX_DECIMALS} 之间`)
  }
  const scale = Math.pow(10, decimals)
  const lo = Math.ceil(Math.min(min, max) * scale - 1e-9)
  const hi = Math.floor(Math.max(min, max) * scale + 1e-9)
  if (hi < lo) throw new RangeError('这个范围里没有可取的值')
  const space = hi - lo + 1
  if (space > 0x100000000) throw new RangeError('范围太大，请缩小范围或减少小数位数')
  if (!allowDuplicates && count > space) throw new RangeError(`不重复时最多只能取 ${space} 个`)

  let ints: number[]
  if (allowDuplicates) {
    ints = []
    for (let i = 0; i < count; i++) ints.push(randomInt(lo, hi, src))
  } else if (space <= SHUFFLE_LIMIT) {
    const pool: number[] = []
    for (let v = lo; v <= hi; v++) pool.push(v)
    ints = draw(pool, count, src)
  } else {
    const seen = new Set<number>()
    while (seen.size < count) seen.add(randomInt(lo, hi, src))
    ints = Array.from(seen)
  }
  if (sort) ints.sort((a, b) => a - b)
  return ints.map((v) => (v / scale).toFixed(decimals))
}

/** 持久缓存命名空间 */
export const STORE_NS = 'random-number'
