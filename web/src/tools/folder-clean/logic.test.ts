import { describe, expect, it } from 'vitest'
import type { DirItem } from '@/native/dir'
import {
  allSelected, applyDeleteResult, chunkIds, deleteSummary, formatBytes, mergeDeleteResults, scanSummary, selectedTotals, sortItems,
  thresholdBytes, thresholdLabel, toggleAll, toggleSelect,
} from './logic'

/** 造一个扫描项 */
function item(id: string, bytes: number, over: Partial<DirItem> = {}): DirItem {
  return { id, name: id, relPath: over.relPath ?? id, bytes, lastModifiedMs: 1000, isDir: false, ...over }
}

describe('formatBytes / threshold', () => {
  it('各量级', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50.0 MB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })
  it('阈值换算与文字', () => {
    expect(thresholdBytes(50)).toBe(52428800)
    expect(thresholdLabel(100)).toBe('100 MB')
    expect(thresholdLabel(1024)).toBe('1 GB')
  })
})

describe('sortItems', () => {
  const items = [item('a', 5, { lastModifiedMs: 300 }), item('b', 9, { lastModifiedMs: 100 }), item('c', 9, { lastModifiedMs: 0 })]
  it('按大小：大在前，并列按路径', () => {
    expect(sortItems(items, 'size').map((i) => i.id)).toEqual(['b', 'c', 'a'])
  })
  it('按时间：旧在前，未知时间排最后', () => {
    expect(sortItems(items, 'time').map((i) => i.id)).toEqual(['b', 'a', 'c'])
  })
  it('按路径，且不改原数组', () => {
    const rev = [item('z', 1), item('y', 1)]
    expect(sortItems(rev, 'path').map((i) => i.id)).toEqual(['y', 'z'])
    expect(rev[0].id).toBe('z')
  })
})

describe('勾选与合计', () => {
  const items = [item('a', 5), item('b', 7)]
  it('toggleSelect 增删且返回新集合', () => {
    const s = new Set<string>()
    const s1 = toggleSelect(s, 'a')
    expect([...s1]).toEqual(['a'])
    expect(s.size).toBe(0)
    expect(toggleSelect(s1, 'a').size).toBe(0)
  })
  it('toggleAll：全选后再点清空', () => {
    const all = toggleAll(items, new Set())
    expect(allSelected(items, all)).toBe(true)
    expect(toggleAll(items, all).size).toBe(0)
    expect(toggleAll(items, new Set(['a'])).size).toBe(2)
  })
  it('空列表不算全选', () => {
    expect(allSelected([], new Set())).toBe(false)
  })
  it('selectedTotals 只算已选且在列表里的', () => {
    expect(selectedTotals(items, new Set(['b', 'zzz']))).toEqual({ count: 1, bytes: 7 })
  })
})

describe('删除批次与结果', () => {
  it('chunkIds 按上限切', () => {
    expect(chunkIds(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']])
    expect(chunkIds([])).toEqual([])
    expect(chunkIds(Array.from({ length: 501 }, (_, i) => String(i))).map((c) => c.length)).toEqual([500, 1])
  })
  it('mergeDeleteResults 累加', () => {
    const r = mergeDeleteResults([
      { deleted: 1, freedBytes: 10, failed: [{ id: 'x', message: 'm' }] },
      { deleted: 2, freedBytes: 5, failed: [] },
    ])
    expect(r).toEqual({ deleted: 3, freedBytes: 15, failed: [{ id: 'x', message: 'm' }] })
  })
  it('applyDeleteResult：失败项保留并保持勾选', () => {
    const items = [item('a', 1), item('b', 2), item('c', 3)]
    const r = applyDeleteResult(items, ['a', 'b'], { deleted: 1, freedBytes: 1, failed: [{ id: 'b', message: 'x' }] })
    expect(r.items.map((i) => i.id)).toEqual(['b', 'c'])
    expect([...r.selected]).toEqual(['b'])
  })
  it('摘要文字', () => {
    expect(scanSummary([item('a', 1024)], 10, false)).toBe('共遍历 10 项，命中 1 项，合计 1.0 KB')
    expect(scanSummary([], 0, true)).toContain('结果不完整')
    expect(deleteSummary({ deleted: 2, freedBytes: 2048, failed: [] })).toBe('已删除 2 项，释放 2.0 KB')
    expect(deleteSummary({ deleted: 0, freedBytes: 0, failed: [{ id: 'a', message: '' }] })).toContain('1 项失败')
  })
})
