import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { decideFloat, useFloatStore } from './float'

/** registry 里真实存在的两个工具 id */
const A = 'ruler'
const B = 'dice'

describe('decideFloat', () => {
  it('忙碌优先', () => {
    expect(decideFloat(true, { id: B, name: 'B' }, A)).toBe('busy')
  })
  it('已有别的浮窗要确认，同一个或没有直接浮', () => {
    expect(decideFloat(false, { id: B, name: 'B' }, A)).toBe('confirm')
    expect(decideFloat(false, { id: A, name: 'A' }, A)).toBe('go')
    expect(decideFloat(false, null, A)).toBe('go')
  })
})

describe('useFloatStore', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('float 记下工具 id 与名称，替换旧的', () => {
    const s = useFloatStore()
    expect(s.float(A)).toBe(true)
    expect(s.floating?.id).toBe(A)
    expect(s.floating?.name).toBeTruthy()
    s.float(B)
    expect(s.floating?.id).toBe(B)
  })
  it('未知工具不浮', () => {
    const s = useFloatStore()
    expect(s.float('no-such-tool')).toBe(false)
    expect(s.floating).toBeNull()
  })
  it('restore 返回 id 并清空；close 只清空', () => {
    const s = useFloatStore()
    s.float(A)
    expect(s.restore()).toBe(A)
    expect(s.floating).toBeNull()
    expect(s.restore()).toBeNull()
    s.float(A)
    s.close()
    expect(s.floating).toBeNull()
  })
  it('忙碌按来源计数，全部结束才算空闲，多减不为负', () => {
    const s = useFloatStore()
    s.reportBusy(A, true)
    s.reportBusy(A, true)
    expect(s.isBusy(A)).toBe(true)
    s.reportBusy(A, false)
    expect(s.isBusy(A)).toBe(true)
    s.reportBusy(A, false)
    expect(s.isBusy(A)).toBe(false)
    s.reportBusy(A, false)
    expect(s.isBusy(A)).toBe(false)
    expect(s.busy[A]).toBeUndefined()
  })
  it('忙碌互不影响', () => {
    const s = useFloatStore()
    s.reportBusy(A, true)
    expect(s.isBusy(B)).toBe(false)
  })
})
