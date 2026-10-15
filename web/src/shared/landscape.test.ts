import { describe, expect, it, vi } from 'vitest'

// landscape 间接引入 bridge，bridge 在加载时读 window；node 环境下先给一个空的
vi.stubGlobal('window', {})
const { createLandscape } = await import('./landscape')

/** 造假依赖 */
function deps() {
  return { orientation: vi.fn(async () => undefined), immersive: vi.fn(async () => undefined) }
}

describe('createLandscape', () => {
  it('enter 切横屏并沉浸，leave 还原', async () => {
    const d = deps()
    const l = createLandscape(d)
    await l.enter()
    expect(d.orientation).toHaveBeenLastCalledWith('landscape')
    expect(d.immersive).toHaveBeenLastCalledWith(true)
    await l.leave()
    expect(d.immersive).toHaveBeenLastCalledWith(false)
    expect(d.orientation).toHaveBeenLastCalledWith('portrait')
  })

  it('没进过横屏时 leave 什么都不做，重复 leave 只还原一次', async () => {
    const d = deps()
    const l = createLandscape(d)
    await l.leave()
    expect(d.orientation).not.toHaveBeenCalled()
    await l.enter()
    await l.leave()
    await l.leave()
    expect(d.orientation).toHaveBeenCalledTimes(2)
  })

  it('无宿主（调用抛错）时静默，且不会误还原', async () => {
    const d = deps()
    d.orientation.mockRejectedValue(new Error('no host'))
    const l = createLandscape(d)
    await expect(l.enter()).resolves.toBeUndefined()
    await l.leave()
    expect(d.immersive).not.toHaveBeenCalled()
  })
})
