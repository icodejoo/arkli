import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '../../shared/toolStorage'
import { createRollCallSettings, KEY_AUTO_STOP, KEY_NO_REPEAT } from './settings'

/** 内存存储 */
function mem(): StorageLike {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

describe('roll-call 共享设置', () => {
  it('默认值：不重复关、自动停止开', () => {
    const s = createRollCallSettings(createToolStorage('t', mem()))
    expect(s.noRepeat.value).toBe(false)
    expect(s.autoStop.value).toBe(true)
    expect(s.spinSeconds.value).toBe(5)
    expect([s.blurPx.value, s.idleRpm.value, s.spinRps.value]).toEqual([1.5, 1.5, 1])
  })
  it('转动时长修改后持久化', async () => {
    const backend = mem()
    const s = createRollCallSettings(createToolStorage('t', backend))
    s.spinSeconds.value = 8
    await Promise.resolve()
    expect(createRollCallSettings(createToolStorage('t', backend)).spinSeconds.value).toBe(8)
  })
  it('修改后持久化，新建实例能读回', async () => {
    const backend = mem()
    const s = createRollCallSettings(createToolStorage('t', backend))
    s.noRepeat.value = true
    s.autoStop.value = false
    await Promise.resolve()
    const s2 = createRollCallSettings(createToolStorage('t', backend))
    expect(s2.noRepeat.value).toBe(true)
    expect(s2.autoStop.value).toBe(false)
    expect(KEY_NO_REPEAT).not.toBe(KEY_AUTO_STOP)
  })
  it('同一份状态两处读取一致，resetUsed 清记录并递增计数', () => {
    const s = createRollCallSettings(createToolStorage('t', mem()))
    const a = s
    const b = s
    a.used.value = ['x']
    expect(b.used.value).toEqual(['x'])
    b.resetUsed()
    expect(a.used.value).toEqual([])
    expect(a.resetSeq.value).toBe(1)
  })
})
