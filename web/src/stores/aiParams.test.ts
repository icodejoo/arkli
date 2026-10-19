import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AiParamsState } from '@/native/ai'

vi.stubGlobal('window', {})

const FAKE_QWEN: AiParamsState = {
  provider: 'local-qwen',
  specs: [
    {
      key: 'temperature',
      label: '采样温度',
      desc: '控制发散度',
      kind: 'slider',
      default: 0.7,
      min: 0,
      max: 1.5,
      step: 0.1,
      advanced: false,
      scope: 'call',
      applyTo: ['prompt'],
    },
  ],
  values: { temperature: 0.7 },
}

const mockGet = vi.fn(async (_p: string) => FAKE_QWEN)
const mockSet = vi.fn(async (_p: string, values: Record<string, number>) => ({
  ...FAKE_QWEN,
  values: { ...FAKE_QWEN.values, ...values },
}))
const mockReset = vi.fn(async (_p: string, _keys?: string[]) => FAKE_QWEN)

vi.mock('@/native/ai', () => ({
  aiParamsGet: (p: string) => mockGet(p),
  aiParamsSet: (p: string, v: Record<string, number>) => mockSet(p, v),
  aiParamsReset: (p: string, k?: string[]) => mockReset(p, k),
}))

import { useAiParamsStore } from './aiParams'

describe('useAiParamsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('初始状态：get 为 undefined', () => {
    const store = useAiParamsStore()
    expect(store.get('local-qwen')).toBeUndefined()
  })

  it('load：首次从原生加载并缓存，二次调用优先使用缓存', async () => {
    const store = useAiParamsStore()
    const first = await store.load('local-qwen')
    expect(first).toEqual(FAKE_QWEN)
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(store.get('local-qwen')).toEqual(FAKE_QWEN)

    // 二次读取不再次调原生
    const second = await store.load('local-qwen')
    expect(second).toBe(first)
    expect(mockGet).toHaveBeenCalledTimes(1)

    // force 刷新会再次调原生
    await store.load('local-qwen', true)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('load：相同 providerId 并发请求时合并去重', async () => {
    const store = useAiParamsStore()
    const [a, b] = await Promise.all([store.load('local-qwen'), store.load('local-qwen')])
    expect(a).toEqual(FAKE_QWEN)
    expect(b).toEqual(FAKE_QWEN)
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('set：调原生并更新缓存', async () => {
    const store = useAiParamsStore()
    await store.load('local-qwen')
    const updated = await store.set('local-qwen', { temperature: 0.9 })
    expect(updated.values.temperature).toBe(0.9)
    expect(store.get('local-qwen')?.values.temperature).toBe(0.9)
    expect(mockSet).toHaveBeenCalledWith('local-qwen', { temperature: 0.9 })
  })

  it('reset：调原生并更新缓存', async () => {
    const store = useAiParamsStore()
    await store.load('local-qwen')
    await store.set('local-qwen', { temperature: 0.9 })
    expect(store.get('local-qwen')?.values.temperature).toBe(0.9)

    // 单项重置
    await store.reset('local-qwen', ['temperature'])
    expect(store.get('local-qwen')?.values.temperature).toBe(0.7)
    expect(mockReset).toHaveBeenCalledWith('local-qwen', ['temperature'])

    // 全部重置
    await store.reset('local-qwen')
    expect(mockReset).toHaveBeenCalledWith('local-qwen', undefined)
  })

  it('load 抛错时不污染缓存且清理 inflight', async () => {
    mockGet.mockRejectedValueOnce(new Error('fail'))
    const store = useAiParamsStore()
    await expect(store.load('err-p')).rejects.toThrow('fail')
    expect(store.get('err-p')).toBeUndefined()

    // 失败后下次调用可重新发起
    mockGet.mockResolvedValueOnce(FAKE_QWEN)
    const retry = await store.load('err-p')
    expect(retry).toEqual(FAKE_QWEN)
  })
})
