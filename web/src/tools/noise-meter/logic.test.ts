import { describe, expect, it } from 'vitest'
import {
  applyOffset, chartPoints, clampOffset, formatDb, gaugeFraction, loadOffset, noiseLevel, OFFSET_KEY, RingBuffer, ringCapacity, saveOffset,
  StatsTracker,
} from './logic'

describe('noiseLevel 阈值', () => {
  it('边界归属', () => {
    expect(noiseLevel(0).label).toBe('很安静')
    expect(noiseLevel(29.9).label).toBe('很安静')
    expect(noiseLevel(30).label).toBe('安静')
    expect(noiseLevel(49.9).label).toBe('安静')
    expect(noiseLevel(50).label).toBe('一般')
    expect(noiseLevel(69.9).label).toBe('一般')
    expect(noiseLevel(70).label).toBe('嘈杂')
    expect(noiseLevel(85).label).toBe('嘈杂')
    expect(noiseLevel(85.1).label).toBe('有害听力')
  })
  it('色调：高噪音告警', () => {
    expect(noiseLevel(40).tone).toBe('ok')
    expect(noiseLevel(80).tone).toBe('warn')
    expect(noiseLevel(100).tone).toBe('bad')
  })
})

describe('校准偏移', () => {
  it('clampOffset 夹到 ±20，取整到 0.5', () => {
    expect(clampOffset(25)).toBe(20)
    expect(clampOffset(-25)).toBe(-20)
    expect(clampOffset(3.3)).toBe(3.5)
    expect(clampOffset(Number.NaN)).toBe(0)
  })
  it('applyOffset 结果夹到 0~140', () => {
    expect(applyOffset(50, 5)).toBe(55)
    expect(applyOffset(2, -20)).toBe(0)
    expect(applyOffset(139, 20)).toBe(140)
  })
  it('保存与读取，读坏数据回 0，存储不可用不抛', () => {
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    saveOffset(7, storage)
    expect(mem.get(OFFSET_KEY)).toBe('7')
    expect(loadOffset(storage)).toBe(7)
    mem.set(OFFSET_KEY, 'abc')
    expect(loadOffset(storage)).toBe(0)
    mem.set(OFFSET_KEY, '99')
    expect(loadOffset(storage)).toBe(20)
    expect(loadOffset(null)).toBe(0)
    expect(() => saveOffset(1, null)).not.toThrow()
    const throwing = {
      getItem: () => {
        throw new Error('x')
      },
      setItem: () => {
        throw new Error('x')
      },
    }
    expect(loadOffset(throwing)).toBe(0)
    expect(() => saveOffset(1, throwing)).not.toThrow()
  })
})

describe('RingBuffer', () => {
  it('未满时按写入顺序', () => {
    const r = new RingBuffer(3)
    r.push(1)
    r.push(2)
    expect(r.values()).toEqual([1, 2])
    expect(r.size).toBe(2)
  })
  it('写满后覆盖最旧的，仍是从旧到新', () => {
    const r = new RingBuffer(3)
    for (const v of [1, 2, 3, 4, 5]) r.push(v)
    expect(r.values()).toEqual([3, 4, 5])
    expect(r.size).toBe(3)
  })
  it('clear 清空后可继续用', () => {
    const r = new RingBuffer(2)
    r.push(1)
    r.push(2)
    r.push(3)
    r.clear()
    expect(r.values()).toEqual([])
    r.push(9)
    expect(r.values()).toEqual([9])
  })
  it('容量至少为 1', () => {
    const r = new RingBuffer(0)
    r.push(1)
    r.push(2)
    expect(r.values()).toEqual([2])
  })
  it('ringCapacity：60 秒按间隔折算', () => {
    expect(ringCapacity(100)).toBe(600)
    expect(ringCapacity(1000)).toBe(60)
    expect(ringCapacity(70)).toBe(858)
  })
})

describe('StatsTracker', () => {
  it('没数据时全为 null', () => {
    expect(new StatsTracker().view()).toEqual({ min: null, max: null, avg: null, count: 0 })
  })
  it('累计最大最小平均，可清零', () => {
    const s = new StatsTracker()
    for (const v of [40, 60, 50]) s.add(v)
    expect(s.view()).toEqual({ min: 40, max: 60, avg: 50, count: 3 })
    s.reset()
    expect(s.view().count).toBe(0)
  })
})

describe('显示换算', () => {
  it('gaugeFraction 20~120 线性并夹取', () => {
    expect(gaugeFraction(20)).toBe(0)
    expect(gaugeFraction(70)).toBe(0.5)
    expect(gaugeFraction(120)).toBe(1)
    expect(gaugeFraction(0)).toBe(0)
    expect(gaugeFraction(140)).toBe(1)
  })
  it('formatDb', () => {
    expect(formatDb(45.26)).toBe('45.3')
    expect(formatDb(null)).toBe('--')
    expect(formatDb(Number.NaN)).toBe('--')
  })
  it('chartPoints：最新点贴右端，数据不满时靠右', () => {
    const pts = chartPoints([20, 120], 5, 400, 100)
    expect(pts).toEqual([
      [300, 100],
      [400, 0],
    ])
    expect(chartPoints([70], 1, 400, 100)).toEqual([[0, 50]])
  })
})
