import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { buildList, calcItem, describeDays, EVENTS_KEY, LEGACY_EVENTS_KEY, loadEvents, parseDay, parseStored, saveEvents, validateEvent, type CountdownEvent } from './logic'

const ev = (date: string, yearly = false, id = date): CountdownEvent => ({ id, name: 'x', date, yearly })
const T = parseDay('2024-03-10')!

describe('parseDay', () => {
  it('合法与非法日期', () => {
    expect(parseDay('2024-02-29')).not.toBeNull()
    expect(parseDay('2023-02-29')).toBeNull()
    expect(parseDay('abc')).toBeNull()
  })
})

describe('calcItem', () => {
  it('一次性事件：未来、今天、过去', () => {
    expect(calcItem(ev('2024-03-15'), T)!.days).toBe(5)
    expect(calcItem(ev('2024-03-10'), T)!.days).toBe(0)
    expect(calcItem(ev('2024-03-01'), T)!.days).toBe(-9)
  })
  it('每年重复取下一次', () => {
    expect(calcItem(ev('2000-03-20', true), T)!.days).toBe(10)
    expect(calcItem(ev('2000-03-01', true), T)!.days).toBe(356)
    expect(calcItem(ev('2000-03-10', true), T)!.days).toBe(0)
  })
  it('2 月 29 日在平年落到 2 月 28 日', () => {
    const r = calcItem(ev('2000-02-29', true), parseDay('2025-01-01')!)!
    expect(r.target).toBe('2025-02-28')
  })
  it('非法日期返回 null', () => {
    expect(calcItem(ev('bad'), T)).toBeNull()
  })
})

describe('buildList / describeDays', () => {
  it('未到的升序在前，已过的由近到远在后', () => {
    const l = buildList([ev('2024-03-01'), ev('2024-03-20'), ev('2024-03-12'), ev('2023-03-10')], T)
    expect(l.map((i) => i.date)).toEqual(['2024-03-12', '2024-03-20', '2024-03-01', '2023-03-10'])
  })
  it('描述文案', () => {
    expect(describeDays(0)).toBe('今天')
    expect(describeDays(3)).toBe('还有 3 天')
    expect(describeDays(-2)).toBe('已过 2 天')
  })
})

describe('validateEvent / parseStored', () => {
  it('校验', () => {
    expect(validateEvent(' ', '2024-01-01')).not.toBe('')
    expect(validateEvent('a', '')).not.toBe('')
    expect(validateEvent('a', '2024-01-01')).toBe('')
  })
  it('解析存储，坏数据丢弃', () => {
    expect(parseStored(null)).toEqual([])
    expect(parseStored('{')).toEqual([])
    expect(parseStored(JSON.stringify([ev('2024-01-01'), { id: 1 }]))).toHaveLength(1)
  })
})

/** 内存存储 */
function memory(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('loadEvents / saveEvents', () => {
  it('存取往返', () => {
    const store = createToolStorage('countdown', memory())
    expect(loadEvents(store)).toEqual([])
    saveEvents(store, [ev('2024-01-01')])
    expect(loadEvents(store)).toEqual([ev('2024-01-01')])
  })
  it('迁移旧键并丢弃坏条目', () => {
    const m = memory()
    m.setItem(LEGACY_EVENTS_KEY, JSON.stringify([ev('2024-01-01'), { id: 1 }]))
    const store = createToolStorage('countdown', m)
    expect(loadEvents(store)).toHaveLength(1)
    expect(m.map.has(LEGACY_EVENTS_KEY)).toBe(false)
    expect(m.map.has(`countdown_${EVENTS_KEY}`)).toBe(true)
  })
  it('缓存不是数组时回落空列表', () => {
    const m = memory()
    m.setItem(`countdown_${EVENTS_KEY}`, '"oops"')
    expect(loadEvents(createToolStorage('countdown', m))).toEqual([])
  })
})
