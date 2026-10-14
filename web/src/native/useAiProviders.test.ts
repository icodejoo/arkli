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

  it('再次 refresh 会覆盖旧结果', async () => {
    const fetcher = vi.fn<() => Promise<AiProviders>>()
    fetcher.mockResolvedValueOnce(SAMPLE).mockResolvedValueOnce({ providers: [], capabilities: [] })
    const ai = useAiProviders(fetcher)
    await ai.refresh()
    await ai.refresh()
    expect(ai.can('translate')).toBe(false)
  })
})
