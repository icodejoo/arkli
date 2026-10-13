// 随机引擎：基于 crypto.getRandomValues，整数用拒绝采样消除取模偏差

/** 随机源：每次返回一个均匀分布的 uint32（0 ~ 2^32-1），测试时可注入固定序列 */
export type RandomSource = () => number

/** uint32 的取值总数 2^32 */
const UINT32_RANGE = 0x100000000

/** 默认随机源，走系统密码学随机数 */
export const cryptoSource: RandomSource = () => {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0]
}

/**
 * 取 [min, max] 闭区间内的均匀随机整数（拒绝采样，无取模偏差）。
 *
 * @param min 下界（整数）
 * @param max 上界（整数，不小于 min，区间宽度不超过 2^32）
 * @param src 随机源，默认密码学随机
 * @returns 区间内的随机整数
 * @throws RangeError 参数不是整数、区间反了或太宽
 * @example
 * randomInt(1, 6) // 掷一次六面骰
 */
export function randomInt(min: number, max: number, src: RandomSource = cryptoSource): number {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new RangeError('randomInt: 区间非法')
  }
  const span = max - min + 1
  if (span > UINT32_RANGE) throw new RangeError('randomInt: 区间过宽')
  // 不超过 limit 的部分才是 span 的整数倍，超出的丢弃重抽
  const limit = UINT32_RANGE - (UINT32_RANGE % span)
  let v = src()
  while (v >= limit) v = src()
  return min + (v % span)
}

/**
 * 从数组里随机取一个元素。
 *
 * @param items 非空数组
 * @param src 随机源
 * @returns 被选中的元素
 * @throws RangeError 数组为空
 * @example
 * pick(['a', 'b']) // 'a' 或 'b'
 */
export function pick<T>(items: readonly T[], src: RandomSource = cryptoSource): T {
  if (items.length === 0) throw new RangeError('pick: 数组为空')
  return items[randomInt(0, items.length - 1, src)]
}

/**
 * Fisher–Yates 洗牌，返回新数组，不改原数组。
 *
 * @param items 待洗牌数组
 * @param src 随机源
 * @returns 洗牌后的新数组
 * @example
 * shuffle([1, 2, 3])
 */
export function shuffle<T>(items: readonly T[], src: RandomSource = cryptoSource): T[] {
  const arr = items.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i, src)
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr
}

/**
 * 不放回抽取 n 个元素。
 *
 * @param items 候选数组
 * @param n 抽取个数（1 ~ items.length）
 * @param src 随机源
 * @returns 按抽中顺序排列的结果
 * @throws RangeError n 越界
 * @example
 * draw(['a', 'b', 'c'], 2)
 */
export function draw<T>(items: readonly T[], n: number, src: RandomSource = cryptoSource): T[] {
  if (!Number.isInteger(n) || n < 1 || n > items.length) throw new RangeError('draw: 数量越界')
  return shuffle(items, src).slice(0, n)
}
