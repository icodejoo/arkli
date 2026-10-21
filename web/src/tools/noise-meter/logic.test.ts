import { describe, expect, it, vi } from 'vitest'
import {
  applyOffset, chartPoints, clampOffset, createPauseGate, formatDb, gaugeFraction, loadOffset, noiseLevel, OFFSET_KEY, LEGACY_OFFSET_KEY, createNoiseStore, RingBuffer, ringCapacity, saveOffset,
  StatsTracker,
} from './logic'
import { createToolStorage } from '@/shared/toolStorage'

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
    const backend = {
      get length() {
        return mem.size
      },
      key: (i: number) => [...mem.keys()][i] ?? null,
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    }
    const store = createNoiseStore(backend)
    saveOffset(7, store)
    expect(mem.get('noise-meter_' + OFFSET_KEY)).toBe('7')
    expect(loadOffset(store)).toBe(7)
    mem.set('noise-meter_' + OFFSET_KEY, '"abc"')
    expect(loadOffset(store)).toBe(0)
    mem.set('noise-meter_' + OFFSET_KEY, '99')
    expect(loadOffset(store)).toBe(20)
    const none = createToolStorage('noise-meter', null)
    expect(loadOffset(none)).toBe(0)
    expect(() => saveOffset(1, none)).not.toThrow()
  })
  it('旧键迁移：旧偏移读入并删除旧键', () => {
    const mem = new Map<string, string>([[LEGACY_OFFSET_KEY, '3.5']])
    const backend = {
      get length() {
        return mem.size
      },
      key: (i: number) => [...mem.keys()][i] ?? null,
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    }
    expect(loadOffset(createNoiseStore(backend))).toBe(3.5)
    expect(mem.has(LEGACY_OFFSET_KEY)).toBe(false)
  })
})
