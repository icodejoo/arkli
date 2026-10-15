import { describe, expect, it, vi } from 'vitest'
import { createWarmup } from './warmup'

/** 造可控依赖：warmup 返回的 promise 由测试手动拒绝 */
function mk() {
  const rejects: Array<(e: unknown) => void> = []
  let signal: AbortSignal | undefined
  const warmup = vi.fn((s: AbortSignal) => {
    signal = s
    return new Promise<unknown>((_, rej) => {
      rejects.push(rej)
    })
  })
  const unload = vi.fn(async () => ({ unloaded: [] }))
  return { warmup, unload, fail: (e: unknown, i = rejects.length - 1) => rejects[i](e), sig: () => signal }
}

/** 等微任务/宏任务跑完 */
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('createWarmup', () => {
  it('重复 warm 只预热一次', () => {
    const d = mk()
    const w = createWarmup(d)
    w.warm()
    w.warm()
    expect(d.warmup).toHaveBeenCalledTimes(1)
  })
  it('release：取消预热并卸载一次；连着触发不重复发', async () => {
    const d = mk()
    const w = createWarmup(d)
    w.warm()
    w.release()
    w.release()
    await tick()
    expect(d.sig()?.aborted).toBe(true)
    expect(d.unload).toHaveBeenCalledTimes(1)
  })
  it('没预热过就 release：不发 unload', async () => {
    const d = mk()
    createWarmup(d).release()
    await tick()
    expect(d.unload).not.toHaveBeenCalled()
  })
  it('release 后可再次进入重新预热', () => {
    const d = mk()
    const w = createWarmup(d)
    w.warm()
    w.release()
    w.warm()
    expect(d.warmup).toHaveBeenCalledTimes(2)
  })
  it('预热失败静默，并允许重试', async () => {
    const d = mk()
    const w = createWarmup(d)
    w.warm()
    d.fail({ code: 'UNKNOWN_METHOD' })
    await tick()
    w.warm()
    expect(d.warmup).toHaveBeenCalledTimes(2)
  })
  it('被取消后的旧失败不影响新一轮', async () => {
    const d = mk()
    const w = createWarmup(d)
    w.warm()
    w.release()
    w.warm()
    d.fail({ code: 'CANCELLED' }, 0)
    await tick()
    w.warm()
    expect(d.warmup).toHaveBeenCalledTimes(2)
  })
  it('unload 抛错也静默', async () => {
    const d = mk()
    d.unload.mockRejectedValue(new Error('x'))
    const w = createWarmup(d)
    w.warm()
    expect(() => w.release()).not.toThrow()
    await tick()
  })
})
