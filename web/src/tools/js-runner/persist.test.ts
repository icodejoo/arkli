import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'

/** 内存存储替身 */
function memory(init: Record<string, string>): StorageLike {
  const m = new Map(Object.entries(init))
  return {
    get length() {
      return m.size
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

describe('js-runner 持久化', () => {
  it('旧版代码原文迁入时不做 JSON 解析（代码恰好是数字也要保持字符串）', () => {
    const st = createToolStorage('js-runner', memory({ 'arkli.js-runner.code': '123' }))
    st.adoptLegacy('arkli.js-runner.code', 'code', (raw) => raw)
    expect(usePersistedRef(st, 'code', 'x', (v) => typeof v === 'string').value).toBe('123')
  })
  it('超时缓存不在选项里时回落默认', () => {
    const st = createToolStorage('js-runner', memory({ 'js-runner_timeoutSec': '7' }))
    expect(usePersistedRef(st, 'timeoutSec', 5, (v) => [3, 5, 10, 30].includes(v)).value).toBe(5)
  })
})
