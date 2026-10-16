import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ModelStatus } from '@/native/model'

/** 模拟原生：list 的结果与事件处理器 */
const h = vi.hoisted(() => ({ list: [] as unknown[], handler: null as null | ((d: unknown) => void) }))
vi.mock('@/native/bridge', () => ({
  on: (_e: string, fn: (d: unknown) => void) => {
    h.handler = fn
    return () => undefined
  },
}))
vi.mock('@/native/model', async (orig) => ({
  ...(await orig<typeof import('@/native/model')>()),
  modelList: async () => h.list,
  modelEnsure: async (id: string) => ({ ...st(id, 'downloading', 10), started: true, meteredHint: false }),
}))

import { useModelsStore } from './models'

/** 造一个状态 */
function st(id: string, state: ModelStatus['state'], downloaded = 0): ModelStatus {
  return { id, displayName: id, version: '1', state, totalBytes: 100, downloadedBytes: downloaded, diskBytes: downloaded }
}

describe('useModelsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.list = []
    h.handler = null
  })

  it('init 取一次快照，补出用途与派生字段', async () => {
    h.list = [st('siglip2-mnn-w8', 'installed', 100)]
    const s = useModelsStore()
    s.init()
    await vi.waitFor(() => expect(s.get('siglip2-mnn-w8')).toBeTruthy())
    const m = s.get('siglip2-mnn-w8')!
    expect(m.installed).toBe(true)
    expect(m.purpose).toBe('识别垃圾品类')
    expect(m.progress).toBe(1)
  })

  it('翻译模型新旧 id 都登记了用途', async () => {
    h.list = [st('nllb600m-un6-mnn-w6', 'installed', 100), st('nllb600m-un6-ccm-int4', 'installed', 100)]
    const s = useModelsStore()
    s.init()
    await vi.waitFor(() => expect(s.get('nllb600m-un6-mnn-w6')).toBeTruthy())
    expect(s.get('nllb600m-un6-mnn-w6')!.purpose).toBe('多语翻译')
    expect(s.get('nllb600m-un6-ccm-int4')!.purpose).toBe('多语翻译')
  })

  it('推送整体替换对象并更新进度', async () => {
    const s = useModelsStore()
    s.init()
    h.handler!(st('a', 'downloading', 25))
    const first = s.get('a')!
    expect(first.downloading).toBe(true)
    expect(first.progress).toBe(0.25)
    h.handler!(st('a', 'installed', 100))
    expect(s.get('a')).not.toBe(first)
    expect(s.get('a')!.installed).toBe(true)
  })

  it('晚到的初始快照不覆盖更新的推送', async () => {
    h.list = [st('a', 'absent')]
    const s = useModelsStore()
    s.init()
    h.handler!(st('a', 'downloading', 50))
    await Promise.resolve()
    await Promise.resolve()
    expect(s.get('a')!.state).toBe('downloading')
  })

  it('download 立即采用返回的状态', async () => {
    const s = useModelsStore()
    await s.download('a')
    expect(s.get('a')!.downloading).toBe(true)
  })

  it('init 幂等', () => {
    const s = useModelsStore()
    s.init()
    const first = h.handler
    h.handler = null
    s.init()
    expect(h.handler).toBeNull()
    expect(first).not.toBeNull()
  })
})
