// 汇率换算的纯逻辑：币种表、两种接口响应解析、取汇率（主备）、缓存、金额换算与格式化
import { httpGetJson, type NetCallFn } from '@/native/net'
import { createToolStorage, type ToolStorage } from '@/shared/toolStorage'

/** 主数据源：frankfurter（欧洲央行数据，约 30 种货币） */
export const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest?base='
/** 备用数据源：open.er-api.com（覆盖更广） */
export const ER_API_URL = 'https://open.er-api.com/v6/latest/'
/** 旧版缓存键前缀（localStorage 原始键，后接币种代码），仅用于迁移 */
export const CACHE_KEY_PREFIX = 'arkli.exchange-rate.v1.'
/** 持久缓存命名空间 */
export const STORE_NS = 'exchange-rate'
/** 汇率表缓存键前缀（命名空间内），后接币种代码 */
const RATES_KEY_PREFIX = 'rates_'
/** 默认小数位数 */
export const DEFAULT_DECIMALS = 2

/** 每个币种保留的小数位：日元、韩元、越南盾、印尼盾没有实际使用的小数 */
const ZERO_DECIMAL_CODES = ['JPY', 'KRW', 'VND', 'IDR']

/** 小数位数上限，防止极小数显示过长 */
const MAX_DIGITS = 10

/** 一个币种 */
export interface Currency {
  /** ISO 代码 */
  code: string
  /** 中文名 */
  name: string
}

/** 支持的币种（约 30 个） */
export const CURRENCIES: Currency[] = [
  { code: 'CNY', name: '人民币' },
  { code: 'USD', name: '美元' },
  { code: 'EUR', name: '欧元' },
  { code: 'JPY', name: '日元' },
  { code: 'GBP', name: '英镑' },
  { code: 'HKD', name: '港元' },
  { code: 'KRW', name: '韩元' },
  { code: 'AUD', name: '澳元' },
  { code: 'CAD', name: '加元' },
  { code: 'SGD', name: '新加坡元' },
  { code: 'THB', name: '泰铢' },
  { code: 'PHP', name: '菲律宾比索' },
  { code: 'TWD', name: '新台币' },
  { code: 'MOP', name: '澳门元' },
  { code: 'MYR', name: '马来西亚林吉特' },
  { code: 'IDR', name: '印尼盾' },
  { code: 'VND', name: '越南盾' },
  { code: 'INR', name: '印度卢比' },
  { code: 'CHF', name: '瑞士法郎' },
  { code: 'NZD', name: '新西兰元' },
  { code: 'RUB', name: '俄罗斯卢布' },
  { code: 'AED', name: '阿联酋迪拉姆' },
  { code: 'SAR', name: '沙特里亚尔' },
  { code: 'TRY', name: '土耳其里拉' },
  { code: 'BRL', name: '巴西雷亚尔' },
  { code: 'MXN', name: '墨西哥比索' },
  { code: 'ZAR', name: '南非兰特' },
  { code: 'SEK', name: '瑞典克朗' },
  { code: 'NOK', name: '挪威克朗' },
  { code: 'DKK', name: '丹麦克朗' },
]

/** 汇率表数据来源 */
export type RateSource = 'frankfurter' | 'er-api'

/** 一张汇率表：1 个 base 等于多少各币种 */
export interface RateTable {
  /** 基准币种 */
  base: string
  /** 汇率日期 `YYYY-MM-DD`（接口给出的，UTC） */
  date: string
  /** 币种代码 → 汇率，包含 base 自身（=1） */
  rates: Record<string, number>
  /** 数据来源 */
  source: RateSource
}

/**
 * 币种显示名，如 `人民币 CNY`。
 *
 * @param code 币种代码
 * @returns 显示文本；不认识的代码原样返回
 * @example currencyLabel('CNY') // '人民币 CNY'
 */
export function currencyLabel(code: string): string {
  const c = CURRENCIES.find((x) => x.code === code)
  return c ? `${c.name} ${c.code}` : code
}

/** 清洗汇率表：只留正的有限数，并补上 base=1；一个有效汇率都没有返回 null */
function cleanRates(base: string, raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== 'object') return null
  const rates: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) rates[k.toUpperCase()] = v
  }
  if (!Object.keys(rates).length) return null
  rates[base] = 1
  return rates
}

/**
 * 解析 frankfurter 响应：`{ amount, base, date, rates }`。
 *
 * @param json 响应 JSON
 * @returns 汇率表；结构不对为 null
 * @example parseFrankfurter({ base: 'USD', date: '2026-10-12', rates: { CNY: 7.1 } })?.rates.CNY // 7.1
 */
export function parseFrankfurter(json: unknown): RateTable | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  if (typeof j.base !== 'string' || typeof j.date !== 'string') return null
  const base = j.base.toUpperCase()
  const rates = cleanRates(base, j.rates)
  return rates ? { base, date: j.date, rates, source: 'frankfurter' } : null
}

/**
 * 解析 open.er-api.com 响应：`{ result, base_code, time_last_update_unix, rates }`。
 *
 * @param json 响应 JSON
 * @returns 汇率表；`result` 不是 success 或结构不对为 null
 * @example parseErApi({ result: 'success', base_code: 'USD', time_last_update_unix: 1760227200, rates: { CNY: 7.1 } })?.date // '2025-10-12'
 */
export function parseErApi(json: unknown): RateTable | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  if (j.result !== 'success' || typeof j.base_code !== 'string') return null
  const base = j.base_code.toUpperCase()
  const rates = cleanRates(base, j.rates)
  if (!rates) return null
  const unix = typeof j.time_last_update_unix === 'number' ? j.time_last_update_unix : NaN
  const date = Number.isFinite(unix) ? new Date(unix * 1000).toISOString().slice(0, 10) : ''
  return { base, date, rates, source: 'er-api' }
}

/**
 * 取汇率表：先 frankfurter，失败或不含目标币种再用 open.er-api.com。
 *
 * @param base 基准币种
 * @param target 需要的目标币种（主源缺它时转备用源）
 * @param call 原生调用函数，默认走 bridge（测试时注入）
 * @param signal 取消信号
 * @returns 汇率表；两个源都失败时抛错
 * @example const t = await fetchRates('CNY', 'THB')
 */
export async function fetchRates(base: string, target: string, call?: NetCallFn, signal?: AbortSignal): Promise<RateTable> {
  try {
    const t = parseFrankfurter(await httpGetJson(FRANKFURTER_URL + encodeURIComponent(base), call, { signal }))
    if (t && t.rates[target]) return t
  } catch (e) {
    if (signal?.aborted) throw e
  }
  const t2 = parseErApi(await httpGetJson(ER_API_URL + encodeURIComponent(base), call, { signal }))
  if (!t2 || !t2.rates[target]) throw new Error('汇率接口没有返回这个币种')
  return t2
}

/** 缓存条目 */
export interface CacheEntry {
  /** 汇率表 */
  table: RateTable
  /** 缓存时间戳（毫秒） */
  savedAt: number
}

/**
 * 某币种的缓存键。
 *
 * @param base 基准币种
 * @returns 命名空间内的键
 * @example cacheKey('CNY') // 'rates_CNY'
 */
export function cacheKey(base: string): string {
  return RATES_KEY_PREFIX + base
}

/** 默认持久缓存（惰性创建） */
let defaultStore: ToolStorage | null = null

/**
 * 取默认持久缓存。
 *
 * @returns 汇率工具的缓存实例
 */
function getStore(): ToolStorage {
  return (defaultStore ??= createToolStorage(STORE_NS))
}

/**
 * 写缓存；存储不可用时静默忽略。
 *
 * @param table 汇率表
 * @param now 当前时间戳（毫秒）
 * @param store 持久缓存，默认汇率工具的实例
 * @returns 是否写入成功
 * @example writeCache(table, Date.now())
 */
export function writeCache(table: RateTable, now: number, store: ToolStorage = getStore()): boolean {
  const entry: CacheEntry = { table, savedAt: now }
  return store.set(cacheKey(table.base), entry)
}

/**
 * 读缓存；没有、损坏或存储不可用返回 null。
 *
 * @param base 基准币种
 * @param store 持久缓存，默认汇率工具的实例；读之前会一次性迁移旧键
 * @returns 缓存条目
 * @example const c = readCache('CNY')
 */
export function readCache(base: string, store: ToolStorage = getStore()): CacheEntry | null {
  try {
    store.adoptLegacy(CACHE_KEY_PREFIX + base, cacheKey(base))
    const j = store.get<Partial<CacheEntry> | null>(cacheKey(base), null)
    if (!j || typeof j !== 'object' || typeof j.savedAt !== 'number' || !j.table || j.table.base !== base) return null
    const rates = cleanRates(base, j.table.rates)
    if (!rates) return null
    const source: RateSource = j.table.source === 'er-api' ? 'er-api' : 'frankfurter'
    return { table: { base, date: typeof j.table.date === 'string' ? j.table.date : '', rates, source }, savedAt: j.savedAt }
  } catch {
    return null
  }
}

/**
 * 时间戳转本地 `YYYY-MM-DD HH:mm`。
 *
 * @param ts 毫秒时间戳
 * @returns 文本
 * @example formatCachedAt(new Date(2024, 0, 2, 3, 4).getTime()) // '2024-01-02 03:04'
 */
export function formatCachedAt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 币种保留的小数位数：日元、韩元、越南盾、印尼盾为 0，其余 2。
 *
 * @param code 币种代码
 * @returns 小数位数
 * @example decimalsFor('JPY') // 0
 */
export function decimalsFor(code: string): number {
  return ZERO_DECIMAL_CODES.includes(code) ? 0 : DEFAULT_DECIMALS
}

/**
 * 四舍五入到指定小数位（远离零的「五入」）。
 * 先用 `toPrecision(12)` 抹掉二进制浮点噪声（如 1.005 实际是 1.00499…），再按位取整，所以 1.005 → 1.01。
 *
 * @param x 数值
 * @param digits 小数位数，0~10
 * @returns 舍入后的数
 * @example roundHalfUp(1.005, 2) // 1.01
 */
export function roundHalfUp(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x
  const f = 10 ** digits
  const scaled = Number((Math.abs(x) * f).toPrecision(12))
  return (Math.sign(x) * Math.round(scaled)) / f
}

/**
 * 金额换算：金额 × 汇率，按目标币种的小数位舍入。
 *
 * @param amount 金额
 * @param rate 汇率（1 个源币种 = rate 个目标币种）
 * @param decimals 结果小数位数
 * @returns 舍入后的结果
 * @example convert(100, 7.1234, 2) // 712.34
 */
export function convert(amount: number, rate: number, decimals: number): number {
  return roundHalfUp(amount * rate, decimals)
}

/**
 * 解析金额输入：允许千分位逗号与空格，只接受非负数。
 *
 * @param text 输入
 * @returns 数值；不合法为 null
 * @example parseAmount('1,234.5') // 1234.5
 */
export function parseAmount(text: string): number | null {
  const s = text.replace(/[,\s]/g, '')
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * 解析手动输入的汇率：必须是正数。
 *
 * @param text 输入
 * @returns 汇率；不合法为 null
 * @example parseRate('0.1389') // 0.1389
 */
export function parseRate(text: string): number | null {
  const n = parseAmount(text)
  return n !== null && n > 0 ? n : null
}

/** 给整数部分加千分位 */
function withThousands(fixed: string): string {
  const [int, frac] = fixed.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac === undefined ? grouped : `${grouped}.${frac}`
}

/**
 * 格式化换算结果：千分位 + 定长小数；结果不为 0 却被舍成 0 时多给几位，避免显示成 0.00。
 *
 * @param value 已舍入的结果
 * @param decimals 小数位数
 * @returns 文本
 * @example formatAmount(1234.5, 2) // '1,234.50'
 */
export function formatAmount(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return withThousands((0).toFixed(decimals))
  return withThousands(value.toFixed(Math.min(MAX_DIGITS, decimals)))
}

/**
 * 结果太小（舍入后为 0）时，用更多小数位重新算一次再显示。
 *
 * @param amount 金额
 * @param rate 汇率
 * @param decimals 常规小数位数
 * @returns 显示文本
 * @example formatConverted(1, 0.00028, 2) // '0.00028'
 */
export function formatConverted(amount: number, rate: number, decimals: number): string {
  const rounded = convert(amount, rate, decimals)
  const raw = amount * rate
  if (rounded === 0 && raw > 0) {
    const extra = Math.min(MAX_DIGITS, Math.ceil(-Math.log10(raw)) + 1)
    return formatAmount(roundHalfUp(raw, extra), extra)
  }
  return formatAmount(rounded, decimals)
}

/**
 * 汇率显示：最多 6 位有效数字。
 *
 * @param rate 汇率
 * @returns 文本
 * @example formatRate(0.138888888) // '0.138889'
 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—'
  return String(Number(rate.toPrecision(6)))
}
