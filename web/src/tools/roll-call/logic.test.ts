import { afterEach, describe, expect, it, vi } from 'vitest'
import { createToolStorage } from '../../shared/toolStorage'
import { calcMainButton, createDebouncer, drawNames, isValidCount, loadNames, MAX_PICK, NAMES_KEY, needsPreviewRebuild, parseNames, PREVIEW_DEBOUNCE_MS, previewKey, saveNames, TOOL_NS } from './logic'

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

/** 内存版存储后端 */
function memBackend() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

describe('名单存储', () => {
  it('读写往返', () => {
    const b = memBackend()
    const store = createToolStorage(TOOL_NS, b)
    expect(loadNames(store)).toBe('')
    expect(saveNames('甲\n乙', store)).toBe(true)
    expect(loadNames(store)).toBe('甲\n乙')
  })
  it('迁移旧键（原文不按 JSON 解析）', () => {
    const b = memBackend()
    b.setItem(NAMES_KEY, '123')
    expect(loadNames(createToolStorage(TOOL_NS, b))).toBe('123')
    expect(b.getItem(NAMES_KEY)).toBeNull()
  })
  it('存储不可用时静默', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadNames()).toBe('')
    expect(saveNames('x')).toBe(false)
  })
})

describe('isValidCount', () => {
  it('只认 1..MAX_PICK 的整数', () => {
    expect(isValidCount(1)).toBe(true)
    expect(isValidCount(MAX_PICK)).toBe(true)
    expect(isValidCount(0)).toBe(false)
    expect(isValidCount(MAX_PICK + 1)).toBe(false)
    expect(isValidCount(1.5)).toBe(false)
    expect(isValidCount('2')).toBe(false)
  })
})

describe('calcMainButton', () => {
  const base = { rolling: false, autoStop: true, stopping: false, ocrBusy: false }
  it('空闲：开抽、可点', () => {
    expect(calcMainButton(base)).toEqual({ text: '开抽', disabled: false, loading: false, danger: false })
  })
  it('自动模式滚动中：禁用并转圈', () => {
    expect(calcMainButton({ ...base, rolling: true })).toEqual({ text: '开抽', disabled: true, loading: true, danger: false })
  })
  it('手动模式滚动中：红色“停止”，可点且不转圈', () => {
    expect(calcMainButton({ ...base, rolling: true, autoStop: false })).toEqual({ text: '停止', disabled: false, loading: false, danger: true })
  })
  it('手动模式减速中：禁用，不再红', () => {
    const s = calcMainButton({ ...base, rolling: true, autoStop: false, stopping: true })
    expect(s.disabled).toBe(true)
    expect(s.danger).toBe(false)
  })
  it('识别中：禁用并转圈', () => {
    expect(calcMainButton({ ...base, ocrBusy: true })).toEqual({ text: '识别中', disabled: true, loading: true, danger: false })
  })
})

describe('roll-call: 预览重建与防抖', () => {
  it('空名单不重建；有效且指纹变了才重建', () => {
    expect(needsPreviewRebuild([], '')).toBe(false)
    expect(needsPreviewRebuild(['a'], '')).toBe(true)
    expect(needsPreviewRebuild(['a', 'b'], previewKey(['a', 'b']))).toBe(false)
    expect(needsPreviewRebuild(['a', 'c'], previewKey(['a', 'b']))).toBe(true)
  })
  it('防抖：连续触发只执行一次，可取消', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = createDebouncer(fn, PREVIEW_DEBOUNCE_MS)
    d.call()
    vi.advanceTimersByTime(300)
    d.call()
    vi.advanceTimersByTime(300)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
    d.call()
    d.cancel()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
