import { describe, expect, it, vi } from 'vitest'

// cache.ts 间接加载 bridge，node 环境先垫一个空 window
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import { STATS_UNKNOWN, useCacheCard, type CacheCardDeps } from './settingsCache'

/** 造依赖，可覆盖单项 */
function deps(over: Partial<CacheCardDeps> = {}): CacheCardDeps {
  return {
    getStats: vi.fn(async () => ({ bytes: 1536, files: 2, byDir: {} })),
    clear: vi.fn(async () => ({ freedBytes: 1536, deleted: 2, skipped: 0 })),
    confirm: vi.fn(async () => true),
    toast: vi.fn(),
    ...over,
  }
}

describe('useCacheCard', () => {
  it('refresh 显示占用，失败显示兜底', async () => {
    const c = useCacheCard(deps())
    await c.refresh()
    expect(c.text.value).toBe('缓存占用 1.5 KB（2 个文件）')
    const bad = useCacheCard(deps({ getStats: vi.fn(async () => Promise.reject(new Error('x'))) }))
    await bad.refresh()
    expect(bad.text.value).toBe(STATS_UNKNOWN)
  })
  it('clean：确认 → 清理 → toast → 刷新', async () => {
    const d = deps()
    const c = useCacheCard(d)
    await c.clean()
    expect(d.clear).toHaveBeenCalledTimes(1)
    expect(d.toast).toHaveBeenCalledWith('已释放 1.5 KB（删除 2 个文件）')
    expect(d.getStats).toHaveBeenCalledTimes(1)
    expect(c.busy.value).toBe(false)
  })
  it('取消确认不清理', async () => {
    const d = deps({ confirm: vi.fn(async () => Promise.reject(new Error('cancel'))) })
    await useCacheCard(d).clean()
    expect(d.clear).not.toHaveBeenCalled()
  })
  it('忙碌时忽略重复点击', async () => {
    let release: () => void = () => undefined
    const d = deps({ clear: vi.fn(() => new Promise<never>((r) => (release = () => r({ freedBytes: 0, deleted: 0, skipped: 0 } as never)))) })
    const c = useCacheCard(d)
    const p = c.clean()
    await Promise.resolve()
    await Promise.resolve()
    await c.clean()
    release()
    await p
    expect(d.clear).toHaveBeenCalledTimes(1)
  })
  it('清理失败 toast 并仍刷新', async () => {
    const d = deps({ clear: vi.fn(async () => Promise.reject({ message: '忙' })) })
    await useCacheCard(d).clean()
    expect(d.toast).toHaveBeenCalledWith('清理失败：忙')
    expect(d.getStats).toHaveBeenCalled()
  })
})
