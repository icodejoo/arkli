import { describe, expect, it, vi } from 'vitest'
import { createProviderWarmup, createWarmup } from './warmup'

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

/** 造按提供者记录调用顺序的依赖；unload 由测试手动放行，便于验证「先卸旧的再预热新的」 */
function mkProv() {
  const log: string[] = []
  const signals = new Map<string, AbortSignal>()
  const releases: Array<() => void> = []
  const warmup = vi.fn((id: string, s: AbortSignal) => {
    log.push(`warm:${id}`)
    signals.set(id, s)
    return new Promise<unknown>(() => {})
  })
  const unload = vi.fn((id: string) => {
    log.push(`unload:${id}`)
    return new Promise<unknown>((res) => releases.push(() => res({ unloaded: [id] })))
  })
  return { warmup, unload, log, signals, finishUnloads: () => releases.splice(0).forEach((f) => f()) }
}

describe('createProviderWarmup', () => {
  it('ready 时预热当前提供者，重复 sync 不重复预热', async () => {
    const d = mkProv()
    const w = createProviderWarmup(d)
    w.sync('local-nllb', true)
    w.sync('local-nllb', true)
    await tick()
    expect(d.log).toEqual(['warm:local-nllb'])
  })
  it('未就绪或没有提供者：不预热；变为就绪后再预热', async () => {
    const d = mkProv()
    const w = createProviderWarmup(d)
    w.sync(undefined, true)
    w.sync('local-qwen', false)
    await tick()
    expect(d.warmup).not.toHaveBeenCalled()
    w.sync('local-qwen', true)
    await tick()
    expect(d.log).toEqual(['warm:local-qwen'])
  })
  it('切换提供者：先取消并卸载旧的，卸完才预热新的', async () => {
    const d = mkProv()
    const w = createProviderWarmup(d)
    w.sync('local-nllb', true)
    await tick()
    w.sync('local-qwen', true)
    await tick()
    expect(d.signals.get('local-nllb')?.aborted).toBe(true)
    expect(d.log).toEqual(['warm:local-nllb', 'unload:local-nllb'])
    d.finishUnloads()
    await tick()
    expect(d.log).toEqual(['warm:local-nllb', 'unload:local-nllb', 'warm:local-qwen'])
  })
  it('旧的从没预热过（未就绪）：切换时不发卸载', async () => {
    const d = mkProv()
    const w = createProviderWarmup(d)
    w.sync('local-nllb', false)
    w.sync('local-qwen', true)
    await tick()
    expect(d.log).toEqual(['warm:local-qwen'])
  })
  it('离页释放当前的；回来时等卸载结束再重新预热', async () => {
    const d = mkProv()
    const w = createProviderWarmup(d)
    w.sync('local-qwen', true)
    await tick()
    w.release()
    w.release()
    w.sync('local-qwen', true)
    await tick()
    expect(d.log).toEqual(['warm:local-qwen', 'unload:local-qwen'])
    d.finishUnloads()
    await tick()
    expect(d.log).toEqual(['warm:local-qwen', 'unload:local-qwen', 'warm:local-qwen'])
  })
  it('等卸载期间又切走：不会预热中途放弃的那个', async () => {
    const d = mkProv()
    const w = createProviderWarmup(d)
    w.sync('local-nllb', true)
    await tick()
    w.sync('local-qwen', true)
    w.sync('local-qwen', false)
    d.finishUnloads()
    await tick()
    expect(d.warmup).toHaveBeenCalledTimes(1)
  })
  it('本页改走过 Qwen：离页时 NLLB 与 Qwen 一起卸载', async () => {
    const d = mkProv()
    const w = createProviderWarmup(d)
    w.sync('local-nllb', true)
    await tick()
    w.occupy('local-qwen')
    w.release()
    await tick()
    expect(d.log).toEqual(['warm:local-nllb', 'unload:local-nllb', 'unload:local-qwen'])
  })
  it('没用过 Qwen：离页不调用 Qwen 的卸载；重复 release 也不重复卸载', async () => {
    const d = mkProv()
    const w = createProviderWarmup(d)
    w.sync('local-nllb', true)
    await tick()
    w.release()
    w.release()
    await tick()
    expect(d.log).toEqual(['warm:local-nllb', 'unload:local-nllb'])
  })
  it('登记的额外提供者后来成为当前：不再算额外占用，只卸一次', async () => {
    const d = mkProv()
    const w = createProviderWarmup(d)
    w.sync('local-nllb', true)
    w.occupy('local-qwen')
    w.sync('local-qwen', true)
    await tick()
    d.finishUnloads()
    await tick()
    w.release()
    await tick()
    expect(d.log.filter((x) => x === 'unload:local-qwen')).toHaveLength(1)
  })
})
