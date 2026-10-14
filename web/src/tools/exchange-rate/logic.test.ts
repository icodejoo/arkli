import { describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import type { NetCallFn } from '@/native/net'
import {
  cacheKey, convert, currencyLabel, CURRENCIES, decimalsFor, fetchRates, formatAmount, formatCachedAt, formatConverted, formatRate,
  parseAmount, parseErApi, parseFrankfurter, parseRate, readCache, roundHalfUp, writeCache, type RateTable, type StorageLike,
} from './logic'

/** frankfurter 样例 */
const FRANK = { amount: 1, base: 'CNY', date: '2026-10-12', rates: { USD: 0.14, JPY: 21.5, THB: 4.6 } }
/** er-api 样例 */
const ER = { result: 'success', base_code: 'CNY', time_last_update_unix: 1760227200, rates: { CNY: 1, USD: 0.14, TWD: 4.5 } }

/** 构造 HTTP 响应 */
function http(status: number, body: unknown) {
  return { status, statusText: '', url: '', redirects: [], headers: {}, body: JSON.stringify(body), bodyEncoding: 'text', truncated: false, elapsedMs: 1 }
}

/** 按顺序返回结果或抛错的假 call */
function seq(...steps: Array<unknown | Error>) {
  const fn = vi.fn(async () => {
    const s = steps.shift()
    if (s instanceof Error) throw s
    return s
  })
  return fn as unknown as NetCallFn & typeof fn
}

/** 内存存储 */
function memStore(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {}
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

describe('币种表', () => {
  it('约 30 个、代码不重复、含常用币种', () => {
    expect(CURRENCIES.length).toBe(30)
    expect(new Set(CURRENCIES.map((c) => c.code)).size).toBe(30)
    for (const code of ['CNY', 'USD', 'EUR', 'JPY', 'GBP', 'HKD', 'KRW', 'AUD', 'CAD', 'SGD', 'THB', 'PHP']) {
      expect(CURRENCIES.some((c) => c.code === code), code).toBe(true)
    }
  })
  it('currencyLabel', () => {
    expect(currencyLabel('CNY')).toBe('人民币 CNY')
    expect(currencyLabel('XXX')).toBe('XXX')
  })
})

describe('parseFrankfurter', () => {
  it('解析并补上 base 自身', () => {
    expect(parseFrankfurter(FRANK)).toEqual({ base: 'CNY', date: '2026-10-12', rates: { USD: 0.14, JPY: 21.5, THB: 4.6, CNY: 1 }, source: 'frankfurter' })
  })
  it('丢掉非法汇率；结构不对返回 null', () => {
    expect(parseFrankfurter({ ...FRANK, rates: { USD: 0, JPY: 'x', THB: 4.6 } })?.rates).toEqual({ THB: 4.6, CNY: 1 })
    expect(parseFrankfurter({ ...FRANK, rates: {} })).toBeNull()
    expect(parseFrankfurter({ base: 'CNY' })).toBeNull()
    expect(parseFrankfurter(null)).toBeNull()
  })
})

describe('parseErApi', () => {
  it('解析，日期取自 unix 时间（UTC）', () => {
    expect(parseErApi(ER)).toEqual({ base: 'CNY', date: '2025-10-12', rates: { CNY: 1, USD: 0.14, TWD: 4.5 }, source: 'er-api' })
  })
  it('result 不是 success 或结构不对返回 null', () => {
    expect(parseErApi({ ...ER, result: 'error' })).toBeNull()
    expect(parseErApi({ result: 'success' })).toBeNull()
    expect(parseErApi('x')).toBeNull()
  })
  it('没有时间字段日期为空', () => {
    expect(parseErApi({ result: 'success', base_code: 'USD', rates: { CNY: 7 } })?.date).toBe('')
  })
})

describe('fetchRates', () => {
  it('主源成功就不查备用', async () => {
    const call = seq(http(200, FRANK))
    expect((await fetchRates('CNY', 'THB', call)).source).toBe('frankfurter')
    expect(call).toHaveBeenCalledTimes(1)
    expect((call.mock.calls[0] as unknown as [string, { url: string }])[1].url).toBe('https://api.frankfurter.dev/v1/latest?base=CNY')
  })
  it('主源失败回退备用', async () => {
    const call = seq(new Error('x'), http(200, ER))
    expect((await fetchRates('CNY', 'USD', call)).source).toBe('er-api')
    expect((call.mock.calls[1] as unknown as [string, { url: string }])[1].url).toBe('https://open.er-api.com/v6/latest/CNY')
  })
  it('主源缺目标币种（如 TWD）转备用', async () => {
    const t = await fetchRates('CNY', 'TWD', seq(http(200, FRANK), http(200, ER)))
    expect(t.source).toBe('er-api')
    expect(t.rates.TWD).toBe(4.5)
  })
  it('两个源都不行抛错', async () => {
    await expect(fetchRates('CNY', 'USD', seq(http(500, {}), http(200, { result: 'error' })))).rejects.toThrow('没有返回')
    await expect(fetchRates('CNY', 'USD', seq(new Error('a'), new Error('b')))).rejects.toThrow('b')
  })
  it('已取消不再回退', async () => {
    const ac = new AbortController()
    ac.abort()
    const call = seq(new Error('cancelled'), http(200, ER))
    await expect(fetchRates('CNY', 'USD', call, ac.signal)).rejects.toThrow('cancelled')
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('缓存', () => {
  const table: RateTable = { base: 'CNY', date: '2026-10-12', rates: { CNY: 1, USD: 0.14 }, source: 'frankfurter' }
  it('键名', () => {
    expect(cacheKey('CNY')).toBe('arkli.exchange-rate.v1.CNY')
  })
  it('写入再读出', () => {
    const st = memStore()
    expect(writeCache(table, 1234, st)).toBe(true)
    expect(readCache('CNY', st)).toEqual({ table, savedAt: 1234 })
    expect(readCache('USD', st)).toBeNull()
  })
  it('损坏数据返回 null', () => {
    const st = memStore()
    st.data[cacheKey('CNY')] = '{bad'
    expect(readCache('CNY', st)).toBeNull()
    st.data[cacheKey('CNY')] = JSON.stringify({ savedAt: 1, table: { base: 'CNY', rates: {} } })
    expect(readCache('CNY', st)).toBeNull()
    st.data[cacheKey('CNY')] = JSON.stringify({ table })
    expect(readCache('CNY', st)).toBeNull()
  })
  it('存储抛错时不崩', () => {
    const bad: StorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(writeCache(table, 1, bad)).toBe(false)
    expect(readCache('CNY', bad)).toBeNull()
  })
  it('formatCachedAt 用本地时间', () => {
    expect(formatCachedAt(new Date(2024, 0, 2, 3, 4).getTime())).toBe('2024-01-02 03:04')
  })
})

describe('舍入与换算', () => {
  it('roundHalfUp：抹掉浮点噪声，五入远离零', () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01)
    expect(roundHalfUp(2.675, 2)).toBe(2.68)
    expect(roundHalfUp(-1.005, 2)).toBe(-1.01)
    expect(roundHalfUp(0.5, 0)).toBe(1)
    expect(roundHalfUp(1.004, 2)).toBe(1)
    expect(roundHalfUp(NaN, 2)).toBeNaN()
  })
  it('convert', () => {
    expect(convert(100, 7.1234, 2)).toBe(712.34)
    expect(convert(1, 21.5, 0)).toBe(22)
    expect(convert(0, 7, 2)).toBe(0)
  })
  it('decimalsFor', () => {
    expect(decimalsFor('JPY')).toBe(0)
    expect(decimalsFor('KRW')).toBe(0)
    expect(decimalsFor('USD')).toBe(2)
  })
})

describe('解析输入', () => {
  it('parseAmount', () => {
    expect(parseAmount('1,234.5')).toBe(1234.5)
    expect(parseAmount(' 12 ')).toBe(12)
    expect(parseAmount('.5')).toBe(0.5)
    expect(parseAmount('0')).toBe(0)
    for (const bad of ['', 'abc', '-1', '1.2.3', '1e3']) expect(parseAmount(bad), bad).toBeNull()
  })
  it('parseRate 必须为正', () => {
    expect(parseRate('0.1389')).toBe(0.1389)
    expect(parseRate('0')).toBeNull()
    expect(parseRate('x')).toBeNull()
  })
})

describe('格式化', () => {
  it('formatAmount：千分位与定长小数', () => {
    expect(formatAmount(1234567.5, 2)).toBe('1,234,567.50')
    expect(formatAmount(22, 0)).toBe('22')
    expect(formatAmount(0, 2)).toBe('0.00')
    expect(formatAmount(NaN, 2)).toBe('—')
  })
  it('formatConverted：太小的结果多给几位', () => {
    expect(formatConverted(100, 7.1234, 2)).toBe('712.34')
    expect(formatConverted(1, 0.00028, 2)).toBe('0.00028')
    expect(formatConverted(0, 0.5, 2)).toBe('0.00')
  })
  it('formatRate：最多 6 位有效数字', () => {
    expect(formatRate(0.138888888)).toBe('0.138889')
    expect(formatRate(7.1)).toBe('7.1')
    expect(formatRate(Infinity)).toBe('—')
  })
})
