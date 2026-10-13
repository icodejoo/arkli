import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_PREFIX,
  EXTRACT_MAX,
  HistoryError,
  buildUrl,
  cacheKey,
  classifyError,
  formatHistoryYear,
  historyErrorText,
  loadHistory,
  parseEvents,
  resetHistoryCache,
  type HistoryDeps,
} from './history-today'

/** 造一个返回指定 JSON 的 fetch 假实现 */
function okFetch(json: unknown, status = 200) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => json }))
}

/** 内存版 storage 假实现 */
function memStorage(): NonNullable<HistoryDeps['storage']> & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

/** 一份样例响应 */
const SAMPLE = {
  events: [
    {
      year: 1894,
      text: '黄海海战。',
      pages: [
        { title: '1894年', description: '年份', extract: '' },
        { title: '黄海海战_(1894年)', normalizedtitle: '黄海海战 (1894年)', description: '1894年中日海战', extract: '简介'.repeat(200) },
      ],
    },
    { year: -44, text: '凯撒遇刺。', pages: [{ title: '凯撒', description: '罗马统帅', extract: '尤利乌斯·凯撒' }] },
    { year: 2024, text: '没有词条的事件', pages: [{ title: '2024年', description: '年份', extract: '' }] },
    { year: 1000, text: '' },
    { text: '缺年份' },
  ],
}

beforeEach(() => resetHistoryCache())

describe('URL 与键', () => {
  it('月日补零', () => {
    expect(buildUrl(2, 9)).toMatch(/\/events\/02\/09$/)
    expect(buildUrl(12, 31)).toMatch(/\/events\/12\/31$/)
  })

  it('2 月 29 日也能构造，键一致', () => {
    expect(buildUrl(2, 29)).toMatch(/\/02\/29$/)
    expect(cacheKey(2, 29)).toBe('02-29')
    expect(cacheKey(10, 5)).toBe('10-05')
  })
})

describe('年份格式化', () => {
  it('公元年、公元前', () => {
    expect(formatHistoryYear(1894)).toBe('1894 年')
    expect(formatHistoryYear(1)).toBe('1 年')
    expect(formatHistoryYear(-44)).toBe('公元前 44 年')
    expect(formatHistoryYear(0)).toBe('公元前 1 年')
  })
})

describe('解析与精简', () => {
  it('正常：按年份倒序，丢弃缺字段事件，跳过年份词条挑关联词条', () => {
    const list = parseEvents(SAMPLE)
    expect(list.map((e) => e.year)).toEqual([2024, 1894, -44])
    expect(list[0]!.note).toBeNull()
    expect(list[1]!.note!.title).toBe('黄海海战 (1894年)')
    expect(list[1]!.note!.desc).toBe('1894年中日海战')
    expect(list[2]!.note).toEqual({ title: '凯撒', desc: '罗马统帅', extract: '尤利乌斯·凯撒' })
  })

  it('简介被截断到上限', () => {
    expect(parseEvents(SAMPLE)[1]!.note!.extract.length).toBe(EXTRACT_MAX)
  })

  it('空数组返回空列表；结构不对抛 parse 错误', () => {
    expect(parseEvents({ events: [] })).toEqual([])
    expect(() => parseEvents({})).toThrow(HistoryError)
    expect(() => parseEvents(null)).toThrow(HistoryError)
    expect(() => parseEvents({ events: 'x' })).toThrow(HistoryError)
  })

  it('缺 pages 的事件不可展开，但保留', () => {
    expect(parseEvents({ events: [{ year: 1500, text: '某事' }] })).toEqual([{ year: 1500, text: '某事', note: null }])
  })

  it('不保留 pages 里的大字段（缩略图、html 等）', () => {
    const big = {
      events: [{ year: 1, text: 't', pages: [{ title: 'A', description: 'd', extract: 'e', thumbnail: { source: 'x' }, extract_html: '<p>x</p>', content_urls: {} }] }],
    }
    expect(Object.keys(parseEvents(big)[0]!.note!).sort()).toEqual(['desc', 'extract', 'title'])
  })
})

describe('错误分类', () => {
  it('429、非 200、网络、解析', async () => {
    await expect(loadHistory(1, 1, { fetchFn: okFetch({}, 429), storage: null })).rejects.toMatchObject({ kind: 'rate-limit' })
    resetHistoryCache()
    await expect(loadHistory(1, 1, { fetchFn: okFetch({}, 500), storage: null })).rejects.toMatchObject({ kind: 'http' })
    resetHistoryCache()
    const net = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(loadHistory(1, 1, { fetchFn: net, storage: null })).rejects.toMatchObject({ kind: 'network' })
    resetHistoryCache()
    const badJson = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('x')
      },
    }))
    await expect(loadHistory(1, 1, { fetchFn: badJson, storage: null })).rejects.toMatchObject({ kind: 'parse' })
    resetHistoryCache()
    await expect(loadHistory(1, 1, { fetchFn: okFetch({ foo: 1 }), storage: null })).rejects.toMatchObject({ kind: 'parse' })
  })

  it('超时：到点 abort 归为 timeout', async () => {
    const hang = (_u: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    await expect(loadHistory(1, 2, { fetchFn: hang, storage: null, timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('classifyError 与友好文案', () => {
    expect(classifyError(new HistoryError('http', 'x'))).toBe('http')
    expect(classifyError(Object.assign(new Error(), { name: 'AbortError' }))).toBe('timeout')
    expect(classifyError('随便什么')).toBe('network')
    for (const k of ['timeout', 'rate-limit', 'http', 'network', 'parse'] as const) expect(historyErrorText(k).length).toBeGreaterThan(0)
  })

  it('失败不缓存，重试可再请求', async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('x'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => SAMPLE })
    await expect(loadHistory(3, 3, { fetchFn: f, storage: null })).rejects.toBeInstanceOf(HistoryError)
    expect((await loadHistory(3, 3, { fetchFn: f, storage: null })).length).toBe(3)
    expect(f).toHaveBeenCalledTimes(2)
  })
})

describe('缓存', () => {
  it('同一天第二次不再请求（内存命中）', async () => {
    const f = okFetch(SAMPLE)
    const a = await loadHistory(9, 17, { fetchFn: f, storage: null })
    const b = await loadHistory(9, 17, { fetchFn: f, storage: null })
    expect(f).toHaveBeenCalledTimes(1)
    expect(b).toBe(a)
  })

  it('换日期会再请求；并发同一天只请求一次', async () => {
    const f = okFetch(SAMPLE)
    await Promise.all([loadHistory(1, 1, { fetchFn: f, storage: null }), loadHistory(1, 1, { fetchFn: f, storage: null })])
    await loadHistory(1, 2, { fetchFn: f, storage: null })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('写入精简结果到 sessionStorage，内存清空后从存储读，不再请求', async () => {
    const st = memStorage()
    const f = okFetch(SAMPLE)
    await loadHistory(9, 17, { fetchFn: f, storage: st })
    const raw = st.data.get(CACHE_PREFIX + '09-17')!
    expect(raw).not.toContain('thumbnail')
    expect(raw.length).toBeLessThan(2000)
    resetHistoryCache()
    const again = await loadHistory(9, 17, { fetchFn: f, storage: st })
    expect(f).toHaveBeenCalledTimes(1)
    expect(again.map((e) => e.year)).toEqual([2024, 1894, -44])
  })

  it('存储写入失败或数据损坏时静默忽略', async () => {
    const bad = {
      getItem: () => '{坏的',
      setItem: () => {
        throw new Error('quota')
      },
    }
    const f = okFetch(SAMPLE)
    expect((await loadHistory(5, 5, { fetchFn: f, storage: bad })).length).toBe(3)
    expect(f).toHaveBeenCalledTimes(1)
  })
})
