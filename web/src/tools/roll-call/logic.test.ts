import { afterEach, describe, expect, it, vi } from 'vitest'
import { drawNames, loadNames, MAX_PICK, NAMES_KEY, parseNames, saveNames } from './logic'

afterEach(() => vi.unstubAllGlobals())

describe('parseNames', () => {
  it('按行拆分、去空白空行、去重保序', () => {
    expect(parseNames(' 张三 \n\n李四\r\n张三\n 王五')).toEqual(['张三', '李四', '王五'])
  })
  it('兼容逗号顿号分隔', () => {
    expect(parseNames('甲,乙、丙；丁')).toEqual(['甲', '乙', '丙', '丁'])
  })
  it('空文本得空名单', () => {
    expect(parseNames('  \n ')).toEqual([])
  })
})

describe('drawNames', () => {
  const names = ['a', 'b', 'c', 'd', 'e']
  it('抽 n 个且互不相同、都在名单内', () => {
    for (let i = 0; i < 50; i++) {
      const r = drawNames(names, 3, false)
      expect(r.picked).toHaveLength(3)
      expect(new Set(r.picked).size).toBe(3)
      expect(r.picked.every((p) => names.includes(p))).toBe(true)
    }
  })
  it('固定随机可复现：rand=0 取前几个', () => {
    expect(drawNames(names, 2, false, [], () => 0).picked).toEqual(['a', 'b'])
  })
  it('rand 接近 1 取靠后者且不越界', () => {
    expect(drawNames(names, 1, false, [], () => 0.999999).picked).toEqual(['e'])
  })
  it('重复模式不累计已抽、left 为总数', () => {
    const r = drawNames(names, 2, false, ['a'])
    expect(r.used).toEqual(['a'])
    expect(r.left).toBe(5)
    expect(r.exhausted).toBe(false)
  })
  it('不重复模式：累计已抽，直到抽空', () => {
    let used: string[] = []
    const all: string[] = []
    let r = drawNames(names, 2, true, used, () => 0)
    all.push(...r.picked)
    used = r.used
    expect(r.left).toBe(3)
    r = drawNames(names, 2, true, used, () => 0)
    all.push(...r.picked)
    used = r.used
    r = drawNames(names, 2, true, used, () => 0)
    all.push(...r.picked)
    expect(r.picked).toHaveLength(1)
    expect(r.exhausted).toBe(true)
    expect(new Set(all).size).toBe(5)
  })
  it('已抽空再抽返回空并标记 exhausted', () => {
    const r = drawNames(names, 1, true, names)
    expect(r.picked).toEqual([])
    expect(r.exhausted).toBe(true)
  })
  it('抽取数超过名单或上限时截断，非法数量得空', () => {
    expect(drawNames(['x', 'y'], 9, false).picked).toHaveLength(2)
    const big = Array.from({ length: 50 }, (_, i) => String(i))
    expect(drawNames(big, 99, false).picked).toHaveLength(MAX_PICK)
    expect(drawNames(names, 0, false).picked).toEqual([])
    expect(drawNames([], 3, false).picked).toEqual([])
  })
})

describe('名单存储', () => {
  it('读写往返', () => {
    const m = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v) })
    expect(loadNames()).toBe('')
    expect(saveNames('甲\n乙')).toBe(true)
    expect(m.get(NAMES_KEY)).toBe('甲\n乙')
    expect(loadNames()).toBe('甲\n乙')
  })
  it('存储不可用时静默', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadNames()).toBe('')
    expect(saveNames('x')).toBe(false)
  })
})
