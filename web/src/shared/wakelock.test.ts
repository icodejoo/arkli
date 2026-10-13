import { describe, expect, it, vi } from 'vitest'
import { createWakeLock, type VisibilityDoc, type WakeNavigator } from './wakelock'

/** 假文档，可手动触发可见性事件 */
function fakeDoc() {
  let fn: (() => void) | undefined
  const d: VisibilityDoc & { show(): void } = {
    visibilityState: 'visible',
    addEventListener: (_t, f) => void (fn = f),
    removeEventListener: () => void (fn = undefined),
    show: () => fn?.(),
  }
  return d
}

/** 造一个可控的 request：每次返回一个带独立 release 的 sentinel，并可延迟兑现 */
function controlledNav() {
  const sentinels: Array<{ release: ReturnType<typeof vi.fn> }> = []
  const gates: Array<() => void> = []
  const request = vi.fn(
    () =>
      new Promise<{ release: () => Promise<void> }>((resolve) => {
        const s = { release: vi.fn(() => Promise.resolve()) }
        sentinels.push(s)
        gates.push(() => resolve(s))
      }),
  )
  const nav: WakeNavigator = { wakeLock: { request } }
  return { nav, request, sentinels, gates }
}

describe('createWakeLock', () => {
  it('不支持时返回 false 不报错', async () => {
    const wl = createWakeLock({}, fakeDoc())
    expect(wl.supported).toBe(false)
    expect(await wl.acquire()).toBe(false)
    await wl.release()
  })
  it('申请被拒绝返回 false', async () => {
    const nav: WakeNavigator = { wakeLock: { request: () => Promise.reject(new Error('NotAllowed')) } }
    expect(await createWakeLock(nav, fakeDoc()).acquire()).toBe(false)
  })
  it('成功申请，释放后调用 release；回到前台自动重申请，且不再重申请', async () => {
    const release = vi.fn(() => Promise.resolve())
    const request = vi.fn(() => Promise.resolve({ release }))
    const doc = fakeDoc()
    const wl = createWakeLock({ wakeLock: { request } }, doc)
    expect(await wl.acquire()).toBe(true)
    doc.show()
    await Promise.resolve()
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(2)
    await wl.release()
    // 重申请覆盖时旧的先释放一次，release() 再释放当前这个
    expect(release).toHaveBeenCalledTimes(2)
    doc.show()
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('request 未返回时 release：拿到的锁立即释放，不悬空', async () => {
    const { nav, sentinels, gates } = controlledNav()
    const wl = createWakeLock(nav, fakeDoc())
    const p = wl.acquire()
    await wl.release()
    gates[0]()
    expect(await p).toBe(false)
    expect(sentinels[0].release).toHaveBeenCalledTimes(1)
  })
  it('连续 acquire：后一个覆盖前先释放旧的', async () => {
    const { nav, sentinels, gates } = controlledNav()
    const wl = createWakeLock(nav, fakeDoc())
    const p1 = wl.acquire()
    gates[0]()
    expect(await p1).toBe(true)
    const p2 = wl.acquire()
    gates[1]()
    expect(await p2).toBe(true)
    expect(sentinels[0].release).toHaveBeenCalledTimes(1)
    expect(sentinels[1].release).not.toHaveBeenCalled()
    await wl.release()
    expect(sentinels[1].release).toHaveBeenCalledTimes(1)
  })
})
