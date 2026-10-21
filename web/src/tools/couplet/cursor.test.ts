import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { CURSOR_KEY_PREFIX, gcd, type Draw, indexAt, LEGACY_CURSOR_KEY_PREFIX, loadCursor, nextDraw, saveCursor, strideFor, type PoolCursor } from './cursor'

/** 内存存储 */
function memBackend(init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...init }
  return {
    data,
    get length() {
      return Object.keys(data).length
    },
    key: (i) => Object.keys(data)[i] ?? null,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  }
}
/** 命名空间前缀，与 cursor.ts 的 NS 一致 */
const NS_PREFIX = 'couplet_'

/** 循环随机源（测试可复现） */
function seq(...vals: number[]): () => number {
  let i = 0
  return () => vals[i++ % vals.length]
}

describe('strideFor / indexAt', () => {
  it('步长与池大小互质，且落在合理范围', () => {
    for (const n of [3, 10, 97, 100, 1000, 720000, 736214, 15448]) {
      for (const seed of [1, 7, 123456789, 4294967295]) {
        const s = strideFor(seed, n)
        expect(gcd(s, n)).toBe(1)
        expect(s).toBeGreaterThanOrEqual(1)
        expect(s).toBeLessThanOrEqual(n)
      }
    }
  })
  it('n 步恰好走遍每个下标一次（小池、含偶数与质数）', () => {
    for (const n of [1, 2, 3, 4, 6, 10, 12, 97, 100, 360]) {
      for (const seed of [0, 5, 99, 2 ** 31]) {
        const seen = new Set<number>()
        for (let k = 0; k < n; k++) seen.add(indexAt(seed, k, n))
        expect(seen.size).toBe(n)
        expect(Math.min(...seen)).toBe(0)
        expect(Math.max(...seen)).toBe(n - 1)
      }
    }
  })
  it('大池也不重复（抽样核对前 5 万次）', () => {
    const n = 736214
    const seen = new Set<number>()
    for (let k = 0; k < 50000; k++) seen.add(indexAt(123, k, n))
    expect(seen.size).toBe(50000)
  })
  it('不同种子给出不同顺序', () => {
    const a = [0, 1, 2, 3].map((k) => indexAt(1, k, 1000))
    const b = [0, 1, 2, 3].map((k) => indexAt(2, k, 1000))
    expect(a).not.toEqual(b)
  })
})

describe('nextDraw', () => {
  it('池为空返回 null', () => {
    expect(nextDraw(null, 0, 10)).toBeNull()
  })
  it('一轮内不重复，抽满后换种子开新一轮', () => {
    const n = 12
    let cur: PoolCursor | null = null
    const first: number[] = []
    for (let i = 0; i < n; i++) {
      const d: Draw = nextDraw(cur, n, 100, seq(11, 22, 33))!
      first.push(d.index)
      expect(d.remaining).toBe(n - 1 - i)
      cur = d.cursor
    }
    expect(new Set(first).size).toBe(n)
    const again = nextDraw(cur, n, 100, seq(44, 55, 66))!
    expect(again.cursor.k).toBe(1)
    expect(again.cursor.seed).not.toBe(11)
  })
  it('换轮时首个不等于上一轮最后一个', () => {
    const n = 7
    // 种子 9 的首项恰是上一轮最后一项时必须跳过它，改用下一个种子
    const cur: PoolCursor = { seed: 5, k: n, n, v: 1, last: indexAt(9, 0, n) }
    let alt = 10
    while (indexAt(alt, 0, n) === cur.last) alt++
    const d = nextDraw(cur, n, 1, seq(9, 9, alt))!
    expect(d.index).not.toBe(cur.last)
    expect(d.cursor.seed).toBe(alt)
  })
  it('池大小或语料条数变了，游标作废重新开始', () => {
    const old: PoolCursor = { seed: 3, k: 5, n: 100, v: 1, last: 4 }
    expect(nextDraw(old, 90, 1, seq(8))!.cursor.k).toBe(1)
    expect(nextDraw(old, 100, 2, seq(8))!.cursor.k).toBe(1)
    expect(nextDraw(old, 100, 1, seq(8))!.cursor.k).toBe(6)
  })
  it('只有一个元素时反复抽都是它', () => {
    const d1 = nextDraw(null, 1, 1, seq(5))!
    expect(d1.index).toBe(0)
    expect(nextDraw(d1.cursor, 1, 1, seq(5))!.index).toBe(0)
  })
})

describe('存取游标', () => {
  const c: PoolCursor = { seed: 1, k: 2, n: 3, v: 4, last: 5 }
  it('存了能读回', () => {
    const m = memBackend()
    const st = createToolStorage('couplet', m)
    saveCursor('全部', c, st)
    expect(m.data[NS_PREFIX + CURSOR_KEY_PREFIX + '全部']).toBeTruthy()
    expect(loadCursor('全部', st)).toEqual(c)
  })
  it('旧键一次性迁移', () => {
    const m = memBackend({ [LEGACY_CURSOR_KEY_PREFIX + 'x']: JSON.stringify(c) })
    expect(loadCursor('x', createToolStorage('couplet', m))).toEqual(c)
    expect(m.data[LEGACY_CURSOR_KEY_PREFIX + 'x']).toBeUndefined()
    expect(m.data[NS_PREFIX + CURSOR_KEY_PREFIX + 'x']).toBeTruthy()
  })
  it('损坏或字段不对当作没有', () => {
    const mk = (raw?: string): ReturnType<typeof createToolStorage> =>
      createToolStorage('couplet', memBackend(raw === undefined ? {} : { [NS_PREFIX + CURSOR_KEY_PREFIX + 'x']: raw }))
    expect(loadCursor('x', mk('{oops'))).toBeNull()
    expect(loadCursor('x', mk(JSON.stringify({ seed: 'a' })))).toBeNull()
    expect(loadCursor('x', mk())).toBeNull()
  })
  it('存储不可用或抛错时不崩', () => {
    expect(loadCursor('x', createToolStorage('couplet', null))).toBeNull()
    saveCursor('x', c, createToolStorage('couplet', null))
    const boom = createToolStorage('couplet', {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error('no')
      },
      setItem: () => {
        throw new Error('no')
      },
      removeItem: () => undefined,
    })
    expect(loadCursor('x', boom)).toBeNull()
    expect(() => saveCursor('x', c, boom)).not.toThrow()
  })
})
