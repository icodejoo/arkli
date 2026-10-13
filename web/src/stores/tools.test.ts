import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useToolsStore } from './tools'

/** 最近使用列表的上限（与 store 内常量保持一致） */
const RECENT_LIMIT = 5

describe('useToolsStore.markUsed', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始为空', () => {
    expect(useToolsStore().recentIds).toEqual([])
  })

  it('新记录置顶', () => {
    const s = useToolsStore()
    s.markUsed('a')
    s.markUsed('b')
    expect(s.recentIds).toEqual(['b', 'a'])
  })

  it('重复使用会去重并移到最前', () => {
    const s = useToolsStore()
    s.markUsed('a')
    s.markUsed('b')
    s.markUsed('a')
    expect(s.recentIds).toEqual(['a', 'b'])
  })

  it('超过上限时丢弃最旧的', () => {
    const s = useToolsStore()
    for (let i = 0; i < RECENT_LIMIT + 2; i++) s.markUsed(`t${i}`)
    expect(s.recentIds).toHaveLength(RECENT_LIMIT)
    expect(s.recentIds[0]).toBe(`t${RECENT_LIMIT + 1}`)
    expect(s.recentIds).not.toContain('t0')
  })

  it('已满时重复使用旧项不会丢项', () => {
    const s = useToolsStore()
    for (let i = 0; i < RECENT_LIMIT; i++) s.markUsed(`t${i}`)
    s.markUsed('t0')
    expect(s.recentIds).toHaveLength(RECENT_LIMIT)
    expect(s.recentIds[0]).toBe('t0')
  })

  it('空串也会被记录（不校验 id）', () => {
    const s = useToolsStore()
    s.markUsed('')
    expect(s.recentIds).toEqual([''])
  })

  it('recent getter 过滤掉未注册的 id，只保留真实工具', () => {
    const s = useToolsStore()
    s.markUsed('ghost')
    s.markUsed('bridge-probe')
    expect(s.recent.map((t) => t.id)).toEqual(['bridge-probe'])
  })
})
