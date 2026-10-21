import { describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import type { NetCallFn } from '@/native/net'
import { createToolStorage } from '@/shared/toolStorage'
import {
  formatMBps, formatMbps, formatMs, formatTime, HISTORY_KEY, HISTORY_MAX, HISTORY_STORE_KEY, TOOL_NS, latencyStats, loadHistory, measureLatency, parseHistory,
  pushHistory, saveHistory, type HistoryEntry,
} from './logic'

/** 造一条历史 */
function entry(ts: number): HistoryEntry {
  return { ts, latencyMin: 10, latencyAvg: 12, jitter: 1, bps: 8e6 }
}

/** 内存存储 */
function memStore(init: Record<string, string> = {}) {
  const data = { ...init }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
    key: (i: number) => Object.keys(data)[i] ?? null,
    get length() {
      return Object.keys(data).length
    },
  }
}

describe('latencyStats', () => {
  it('最小、平均、抖动、丢包', () => {
    expect(latencyStats([10, 20, null, 30])).toEqual({ count: 4, ok: 3, loss: 0.25, min: 10, avg: 20, jitter: 10 })
  })
  it('抖动是相邻成功样本差的平均绝对值', () => {
    expect(latencyStats([10, 14, 11]).jitter).toBeCloseTo(3.5)
  })
  it('单个样本抖动为 0；全部失败为 null；空数组不丢包', () => {
    expect(latencyStats([15]).jitter).toBe(0)
    expect(latencyStats([null, null])).toEqual({ count: 2, ok: 0, loss: 1, min: null, avg: null, jitter: null })
    expect(latencyStats([])).toMatchObject({ count: 0, loss: 0, min: null })
  })
})

describe('measureLatency', () => {
  it('串行 N 次，失败记 null，并逐个回调', async () => {
    const results: unknown[] = [{ ok: true, elapsedMs: 11 }, { ok: false, elapsedMs: 3000, error: 'timeout' }, new Error('denied'), { ok: true, elapsedMs: 13 }]
    const call = vi.fn(async () => {
      const r = results.shift()
      if (r instanceof Error) throw r
      return r
    }) as unknown as NetCallFn
    const got: Array<[number, number | null]> = []
    const s = await measureLatency('1.1.1.1', 443, 4, call, { onSample: (i, ms) => got.push([i, ms]) })
    expect(s).toEqual([11, null, null, 13])
    expect(got.length).toBe(4)
    expect((call as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ host: '1.1.1.1', port: 443 })
  })
  it('取消时抛出', async () => {
    const ac = new AbortController()
    ac.abort()
    const call = vi.fn(async () => {
      throw new Error('cancelled')
    }) as unknown as NetCallFn
    await expect(measureLatency('1.1.1.1', 443, 3, call, { signal: ac.signal })).rejects.toThrow('cancelled')
  })
})

describe('速率与耗时格式化', () => {
  it('Mbps 分档保留位数', () => {
    expect(formatMbps(2_345_000)).toBe('2.35 Mbps')
    expect(formatMbps(23_400_000)).toBe('23.4 Mbps')
    expect(formatMbps(234_000_000)).toBe('234 Mbps')
    expect(formatMbps(NaN)).toBe('—')
    expect(formatMbps(-1)).toBe('—')
  })
  it('MB/s', () => {
    expect(formatMBps(23_400_000)).toBe('2.92 MB/s')
    expect(formatMBps(Infinity)).toBe('—')
  })
  it('毫秒', () => {
    expect(formatMs(12.34)).toBe('12.3 ms')
    expect(formatMs(null)).toBe('—')
  })
})

describe('历史记录', () => {
  it('pushHistory：新的在前，最多 10 条，不改原数组', () => {
    const list = Array.from({ length: HISTORY_MAX }, (_, i) => entry(i))
    const next = pushHistory(list, entry(99))
    expect(next.length).toBe(HISTORY_MAX)
    expect(next[0].ts).toBe(99)
    expect(next[HISTORY_MAX - 1].ts).toBe(HISTORY_MAX - 2)
    expect(list[0].ts).toBe(0)
  })
  it('parseHistory：坏数据返回空，丢掉不合规条目', () => {
    expect(parseHistory(null)).toEqual([])
    expect(parseHistory('{bad')).toEqual([])
    expect(parseHistory('{}')).toEqual([])
    const raw = JSON.stringify([entry(1), { ts: 'x' }, { ...entry(2), bps: 'fast' }, { ...entry(3), bps: null }])
    expect(parseHistory(raw).map((e) => e.ts)).toEqual([1, 3])
  })
  it('save / load 往返', () => {
    const st = memStore()
    const store = createToolStorage(TOOL_NS, st)
    expect(saveHistory([entry(1), entry(2)], store)).toBe(true)
    expect(st.data[`${TOOL_NS}_${HISTORY_STORE_KEY}`]).toBeTruthy()
    expect(loadHistory(store)).toEqual([entry(1), entry(2)])
  })
  it('迁移旧键', () => {
    const st = memStore({ [HISTORY_KEY]: JSON.stringify([entry(7)]) })
    expect(loadHistory(createToolStorage(TOOL_NS, st))).toEqual([entry(7)])
    expect(st.data[HISTORY_KEY]).toBeUndefined()
  })
  it('存储抛错时不崩', () => {
    const bad = createToolStorage(TOOL_NS, {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {},
      key: () => null,
      length: 0,
    })
    expect(loadHistory(bad)).toEqual([])
    expect(saveHistory([entry(1)], bad)).toBe(false)
  })
})

describe('formatTime', () => {
  it('本地 MM-DD HH:mm', () => {
    expect(formatTime(new Date(2024, 0, 2, 3, 4).getTime())).toBe('01-02 03:04')
  })
})
