import { describe, expect, it } from 'vitest'
import { buildList, calcItem, describeDays, parseDay, parseStored, validateEvent, type CountdownEvent } from './logic'

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
