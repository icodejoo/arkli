// 随机且不重复：对池做“固定步长”的循环遍历。步长与池大小 n 互质，所以 n 步内每个下标恰好出现一次；
// 游标只存（种子、已抽个数），不存任何列表；抽完一轮才换种子重新洗牌。
import { cryptoSource, type RandomSource } from '@/shared/random'
import { createToolStorage, type ToolStorage } from '@/shared/toolStorage'

/** 持久缓存里游标的键前缀，后接池名 */
export const CURSOR_KEY_PREFIX = 'cursor.'
/** 旧版 localStorage 里游标的整键前缀，后接池名；读取时一次性迁移 */
export const LEGACY_CURSOR_KEY_PREFIX = 'arkli.couplet.cursor.'
/** 本工具持久缓存的命名空间 */
const NS = 'couplet'

/** 步长取在池大小的这个比例区间内（黄金分割附近，相邻两次抽到的位置离得远） */
const STRIDE_MIN_RATIO = 0.382

/** 步长比例区间的宽度 */
const STRIDE_SPAN_RATIO = 0.236

/** 换种子时为避开“上一轮最后一个 = 新一轮第一个”最多重试几次 */
const RESEED_TRIES = 8

/** uint32 的取值总数 */
const UINT32 = 0x100000000

/** 一个池的游标（可直接 JSON 化存盘） */
export interface PoolCursor {
  /** 本轮的种子（uint32），决定步长与起点 */
  seed: number
  /** 本轮已抽出的个数 */
  k: number
  /** 建游标时池的大小；与现在不一致说明语料变了，游标作废 */
  n: number
  /** 建游标时语料总条数，同上 */
  v: number
  /** 上一次抽到的池内下标，换轮时用来避免首尾重复；没有为 -1 */
  last: number
}

/** 一次抽取的结果 */
export interface Draw {
  /** 池内下标，传给 `corpusGet` */
  index: number
  /** 抽取后的新游标，调用方负责存盘 */
  cursor: PoolCursor
  /** 本轮还剩几副（抽完这一副之后） */
  remaining: number
}

/**
 * 轻量 32 位哈希（mulberry32 的一步），把种子与盐打散成 [0, 1) 的小数。
 *
 * @param seed 种子
 * @param salt 盐，不同用途用不同值
 * @returns 0 ≤ x < 1
 */
export function unit(seed: number, salt: number): number {
  let t = (seed + Math.imul(salt, 0x9e3779b1)) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / UINT32
}

/**
 * 最大公约数。
 *
 * @param a 非负整数
 * @param b 非负整数
 * @returns gcd(a, b)
 */
export function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

/**
 * 由种子算出本轮的步长：落在 n 的 0.382~0.618 附近，并向上调到与 n 互质。
 *
 * @param seed 种子
 * @param n 池大小（≥ 1）
 * @returns 与 n 互质的步长，1 ≤ 步长 ≤ n（n = 1 时为 1）
 * @example strideFor(12345, 100) // 与 100 互质
 */
export function strideFor(seed: number, n: number): number {
  if (n <= 2) return 1
  let s = Math.max(1, Math.floor(n * (STRIDE_MIN_RATIO + STRIDE_SPAN_RATIO * unit(seed, 1))))
  while (gcd(s, n) !== 1) s++
  return s
}

/**
 * 第 k 次抽取对应的池内下标：`(起点 + k × 步长) mod n`。k 取 0 ~ n-1 时恰好走遍 0 ~ n-1 各一次。
 *
 * @param seed 种子
 * @param k 本轮第几次（0 起）
 * @param n 池大小
 * @returns 池内下标
 * @example indexAt(7, 0, 10)
 */
export function indexAt(seed: number, k: number, n: number): number {
  if (n <= 1) return 0
  const start = Math.floor(unit(seed, 2) * n)
  // k < n ≤ 百万级、步长 < n，乘积远小于 2^53，普通数字运算不会丢精度
  return (start + k * strideFor(seed, n)) % n
}

/**
 * 抽下一副。游标无效（没有、池大小或语料条数变了、已抽完）就换种子开新一轮。
 *
 * @param cursor 存下来的游标，没有为 null
 * @param n 池现在的大小；为 0 时没得抽，返回 null
 * @param v 语料现在的总条数
 * @param rand 随机源（只用来换种子），默认密码学随机
 * @returns 本次的下标、新游标与本轮剩余；池为空返回 null
 * @example const d = nextDraw(loaded, 700000, 736214); save(d!.cursor); corpusGet(pool, d!.index)
 */
export function nextDraw(cursor: PoolCursor | null, n: number, v: number, rand: RandomSource = cryptoSource): Draw | null {
  if (n <= 0) return null
  const fresh = !cursor || cursor.n !== n || cursor.v !== v || cursor.k >= n || cursor.k < 0
  let cur: PoolCursor
  if (fresh) {
    const last = cursor && cursor.n === n && cursor.v === v ? cursor.last : -1
    let seed = rand()
    for (let i = 0; i < RESEED_TRIES && n > 1 && indexAt(seed, 0, n) === last; i++) seed = rand()
    cur = { seed, k: 0, n, v, last }
  } else {
    cur = cursor as PoolCursor
  }
  const index = indexAt(cur.seed, cur.k, n)
  return { index, cursor: { ...cur, k: cur.k + 1, last: index }, remaining: n - cur.k - 1 }
}

/** 默认的持久缓存（localStorage 不可用时读写自动静默失败） */
const defaultStore = createToolStorage(NS)

/**
 * 读某个池的游标；损坏或字段不合法当作没有。
 *
 * @param pool 池名
 * @param storage 持久缓存，默认 couplet 命名空间（仅测试注入）
 * @returns 游标，没有为 null
 */
export function loadCursor(pool: string, storage: ToolStorage = defaultStore): PoolCursor | null {
  try {
    storage.adoptLegacy(LEGACY_CURSOR_KEY_PREFIX + pool, CURSOR_KEY_PREFIX + pool)
    const o = storage.get<Partial<PoolCursor> | null>(CURSOR_KEY_PREFIX + pool, null)
    if (!o || typeof o !== 'object') return null
    const ok = [o.seed, o.k, o.n, o.v, o.last].every((x) => typeof x === 'number' && Number.isInteger(x))
    return ok ? (o as PoolCursor) : null
  } catch {
    return null
  }
}

/**
 * 存某个池的游标；存储不可用时静默忽略（这一轮会在页面重开后重新洗牌，不影响使用）。
 *
 * @param pool 池名
 * @param cursor 游标
 * @param storage 持久缓存，默认 couplet 命名空间（仅测试注入）
 */
export function saveCursor(pool: string, cursor: PoolCursor, storage: ToolStorage = defaultStore): void {
  storage.set(CURSOR_KEY_PREFIX + pool, cursor)
}
