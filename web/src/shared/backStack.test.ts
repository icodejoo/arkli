import { effectScope, nextTick, reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'

// 用假的 Popup 代替 vant（测试环境无 DOM），只验证包装逻辑
const fakePopup = vi.hoisted(() => ({ setup: vi.fn(() => 'orig') }))
vi.mock('vant', () => ({ Popup: fakePopup }))

import { handleBack, patchVantPopup, pushBack } from './backStack'

describe('backStack', () => {
  it('空栈不消费返回', () => {
    expect(handleBack()).toBe(false)
  })

  it('后进先出，逐层关闭', () => {
    const a = vi.fn()
    const b = vi.fn()
    pushBack(a)
    pushBack(b)
    expect(handleBack()).toBe(true)
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
    expect(handleBack()).toBe(true)
    expect(a).toHaveBeenCalledTimes(1)
    expect(handleBack()).toBe(false)
  })

  it('注销后不再触发', () => {
    const a = vi.fn()
    const off = pushBack(a)
    off()
    expect(handleBack()).toBe(false)
    expect(a).not.toHaveBeenCalled()
  })
})

describe('patchVantPopup', () => {
  patchVantPopup()
  const setup = fakePopup.setup as unknown as (p: { show: boolean }, c: { emit: (e: string, v: boolean) => void }) => unknown

  it('打开入栈、返回键发出 update:show=false，且仍调用原 setup', async () => {
    const props = reactive({ show: false })
    const emit = vi.fn()
    const scope = effectScope()
    expect(scope.run(() => setup(props, { emit }))).toBe('orig')
    expect(handleBack()).toBe(false)
    props.show = true
    await nextTick()
    expect(handleBack()).toBe(true)
    expect(emit).toHaveBeenCalledWith('update:show', false)
    scope.stop()
  })

  it('自行关闭或卸载后不残留', async () => {
    const props = reactive({ show: true })
    const scope = effectScope()
    scope.run(() => setup(props, { emit: vi.fn() }))
    props.show = false
    await nextTick()
    expect(handleBack()).toBe(false)
    props.show = true
    await nextTick()
    scope.stop()
    expect(handleBack()).toBe(false)
  })
})
