import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiProviders } from './ai'

/** 被测函数；bridge 在加载时会访问 window，所以先桩掉再动态导入 */
let useAiProviders: typeof import('./useAiProviders').useAiProviders

beforeAll(async () => {
  vi.stubGlobal('window', {})
  useAiProviders = (await import('./useAiProviders')).useAiProviders
})

/** 一份“交接可用 + 在线未配置”的探测结果 */
const SAMPLE: AiProviders = {
  providers: [
    { id: 'intent-handoff', displayName: '系统应用交接', available: true, tasks: ['translate', 'summarize'] },
    { id: 'online', displayName: '在线', available: false, reason: 'not_configured', tasks: ['prompt'] },
  ],
  capabilities: ['summarize', 'translate'],
}

describe('useAiProviders', () => {
  it('探测前：ready 为 false，can 全 false', () => {
    const ai = useAiProviders(async () => SAMPLE)
    expect(ai.ready.value).toBe(false)
    expect(ai.can('translate')).toBe(false)
    expect(ai.anyAvailable.value).toBe(false)
  })

  it('refresh 后：能力与 pick 只看可用提供者', async () => {
    const ai = useAiProviders(async () => SAMPLE)
    await ai.refresh()
    expect(ai.ready.value).toBe(true)
    expect(ai.can('translate')).toBe(true)
    expect(ai.can('prompt')).toBe(false)
    expect(ai.pick('translate')?.id).toBe('intent-handoff')
    expect(ai.pick('prompt')).toBeUndefined()
    expect(ai.anyAvailable.value).toBe(true)
  })

  it('探测抛错：当作没有提供者，ready 仍置位', async () => {
    const ai = useAiProviders(
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    await ai.refresh()
    expect(ai.ready.value).toBe(true)
    expect(ai.providers.value).toEqual([])
    expect(ai.anyAvailable.value).toBe(false)
  })

  it('pick 可限定入口：交接的 translate 走 run，要语言对接口时选不到它', async () => {
    const ai = useAiProviders(async () => ({
      providers: [
        { id: 'intent-handoff', displayName: '交接', available: true, tasks: ['translate'], offers: [{ task: 'translate', entry: 'native.ai.run' }] },
        { id: 'local-nllb', displayName: 'NLLB', available: true, tasks: ['translate'], offers: [{ task: 'translate', entry: 'native.ai.translate' }] },
      ],
      capabilities: ['translate'],
    }))
    await ai.refresh()
    expect(ai.pick('translate')?.id).toBe('intent-handoff')
    expect(ai.pick('translate', 'native.ai.translate')?.id).toBe('local-nllb')
    expect(ai.pick('translate', 'native.ai.classify')).toBeUndefined()
  })

  it('ensure：并发只探测一次，探测过后不再调', async () => {
    const fetcher = vi.fn(async () => SAMPLE)
    const ai = useAiProviders(fetcher)
    await Promise.all([ai.ensure(), ai.ensure()])
    expect(fetcher).toHaveBeenCalledTimes(1)
    await ai.ensure()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await ai.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('共用实例：多次取到同一个，reset 后换新', async () => {
    const mod = await import('./useAiProviders')
    const a = mod.useSharedAiProviders()
    expect(mod.useSharedAiProviders()).toBe(a)
    mod.resetSharedAiProviders()
    expect(mod.useSharedAiProviders()).not.toBe(a)
  })

  it('再次 refresh 会覆盖旧结果', async () => {
    const fetcher = vi.fn<() => Promise<AiProviders>>()
    fetcher.mockResolvedValueOnce(SAMPLE).mockResolvedValueOnce({ providers: [], capabilities: [] })
    const ai = useAiProviders(fetcher)
    await ai.refresh()
    await ai.refresh()
    expect(ai.can('translate')).toBe(false)
  })
  it('探测进行中再 refresh：本轮结束后补跑一次，期间多次 refresh 只补一次，返回的 promise 等补跑结束', async () => {
    const releases: Array<() => void> = []
    const fetcher = vi.fn(
      () =>
        new Promise<AiProviders>((res) => {
          releases.push(() => res(fetcher.mock.calls.length >= 2 ? { providers: [], capabilities: [] } : SAMPLE))
        }),
    )
    const ai = useAiProviders(fetcher)
    const p1 = ai.refresh()
    const p2 = ai.refresh()
    const p3 = ai.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1)
    releases[0]()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    releases[1]()
    await Promise.all([p1, p2, p3])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(ai.can('translate')).toBe(false)
    // 补跑过后恢复常态：再 refresh 是新的一轮，只调一次
    const p4 = ai.refresh()
    releases[2]()
    await p4
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
