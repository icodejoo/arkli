import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLongPress, LONG_PRESS_MOVE_PX, LONG_PRESS_MS } from './useLongPress'

/** 造一个只带坐标的触摸事件 */
function touch(x = 0, y = 0): TouchEvent {
  return { touches: [{ clientX: x, clientY: y }] } as unknown as TouchEvent
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createLongPress', () => {
  it('按满时长触发，并吞掉随后的 click 一次', () => {
    const fn = vi.fn()
    const lp = createLongPress(fn)
    lp.start(touch(), 'ruler')
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fn).toHaveBeenCalledWith('ruler')
    lp.end()
    expect(lp.consumeClick()).toBe(true)
    expect(lp.consumeClick()).toBe(false)
  })
  it('没按满就抬起：不触发，click 正常放行', () => {
    const fn = vi.fn()
    const lp = createLongPress(fn)
    lp.start(touch(), 'a')
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    lp.end()
    vi.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
    expect(lp.consumeClick()).toBe(false)
  })
  it('位移超过阈值视为滑动，取消长按；阈值内抖动不影响', () => {
    const fn = vi.fn()
    const lp = createLongPress(fn)
    lp.start(touch(0, 0), 'a')
    lp.move(touch(LONG_PRESS_MOVE_PX - 1, 0))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fn).toHaveBeenCalledTimes(1)
    lp.start(touch(0, 0), 'b')
    lp.move(touch(0, LONG_PRESS_MOVE_PX + 5))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('重新按下会复位上一次的吞 click 标记', () => {
    const lp = createLongPress(vi.fn())
    lp.start(touch(), 'a')
    vi.advanceTimersByTime(LONG_PRESS_MS)
    lp.start(touch(), 'b')
    expect(lp.consumeClick()).toBe(false)
  })
})
