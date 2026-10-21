import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AiProviders } from './ai'

// 模型 store 加载时会引 bridge 的 on；这里不触发 init，桩掉即可
vi.mock('@/native/bridge', () => ({ on: () => () => undefined, call: vi.fn(), isNativeAvailable: () => false }))

import { useModelsStore } from '@/stores/models'
import { CHOICE_KEY_PREFIX, CHOICE_NS } from '@/shared/modelPicker'
import { useAiCatalog } from './useAiCatalog'
import { useAiProviders } from './useAiProviders'
import { resetModelChoiceCache } from './useModelChoice'

/** 翻译相关的两个提供者（与原生同形） */
const PROVIDERS: AiProviders = {
  providers: [
    {
      id: 'local-nllb',
      displayName: '本地翻译（NLLB）',
      layer: 'L1',
      available: true,
      tasks: ['translate'],
      offers: [{ task: 'translate', entry: 'native.ai.translate', constraints: { languages: ['en', 'fr'], sourceAuto: true } }],
      modelId: 'nllb600m-un6-mnn-w6',
      downloaded: true,
      sizeBytes: 10,
      downloading: false,
    },
    {
      id: 'local-qwen',
      displayName: '本地文本模型（Qwen）',
      layer: 'L2',
      available: false,
      tasks: ['translate', 'summarize'],
      offers: [
        { task: 'summarize', entry: 'native.ai.run' },
        { task: 'translate', entry: 'native.ai.translate', constraints: { languages: ['en', 'fr'], sourceAuto: true } },
      ],
      modelId: 'qwen35-0.8b-mnn-q4',
      downloaded: false,
      sizeBytes: 0,
      downloading: false,
    },
  ],
  capabilities: ['translate'],
}

/** 内存 localStorage */
function installStorage(init: Record<string, string> = {}): Map<string, string> {
  const m = new Map(Object.entries(init))
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
  return m
}

describe('useAiCatalog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetModelChoiceCache()
  })

  it('探测前 choice 是存值、current 为空；探测后按目录解析，失效值回落到第一个 ready 的 L1', async () => {
    installStorage({ [CHOICE_KEY_PREFIX + 'translate']: 'gone' })
    const fetcher = vi.fn(async () => PROVIDERS)
    const c = useAiCatalog('translate', useAiProviders(fetcher))
    expect(c.ready.value).toBe(false)
    expect(c.choice.value).toBe('gone')
    expect(c.current.value).toBeUndefined()
    await vi.waitFor(() => expect(c.ready.value).toBe(true))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(c.items.value.map((i) => i.key)).toEqual(['local-nllb', 'local-qwen', 'l4-openai'])
    expect(c.choice.value).toBe('local-nllb')
    expect(c.current.value).toMatchObject({ providerId: 'local-nllb', status: 'ready', constraints: { languages: ['en', 'fr'] } })
  })

  it('旧值迁移后选中 Qwen；状态跟随模型 store 实时变化', async () => {
    installStorage({ [CHOICE_KEY_PREFIX + 'translate']: 'qwen35-0.8b-mnn-q4' })
    const ai = useAiProviders(async () => PROVIDERS)
    const c = useAiCatalog('translate', ai)
    await ai.ensure()
    expect(c.choice.value).toBe('local-qwen')
    expect(c.current.value?.status).toBe('missing')
    const store = useModelsStore()
    store.byId['qwen35-0.8b-mnn-q4'] = {
      id: 'qwen35-0.8b-mnn-q4',
      displayName: 'Qwen',
      version: '1',
      state: 'installed',
      totalBytes: 5,
      downloadedBytes: 5,
      diskBytes: 5,
      purpose: '',
      installed: true,
      downloading: false,
      progress: 1,
    }
    expect(c.current.value?.status).toBe('ready')
  })

  it('set 持久化选择，同工具的其他实例立刻可见', async () => {
    const m = installStorage()
    const ai = useAiProviders(async () => PROVIDERS)
    const a = useAiCatalog('translate', ai)
    const b = useAiCatalog('translate', ai)
    await ai.ensure()
    a.set('local-qwen')
    expect(b.choice.value).toBe('local-qwen')
    expect(m.get(CHOICE_NS + '_translate')).toBe('"local-qwen"')
  })
})
