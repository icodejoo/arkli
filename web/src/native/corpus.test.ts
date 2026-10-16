import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ native: true }))
vi.mock('./bridge', () => ({ call: vi.fn(), isNativeAvailable: () => state.native }))

import { CORPUS_METHODS, corpusGet, corpusInfo } from './corpus'
import { NativeUnavailableError } from './system'

describe('corpusInfo', () => {
  beforeEach(() => {
    state.native = true
  })
  it('无宿主返回未就绪，不调原生', async () => {
    state.native = false
    const call = vi.fn()
    expect(await corpusInfo(call)).toEqual({ ready: false })
    expect(call).not.toHaveBeenCalled()
  })
  it('原样返回原生结果', async () => {
    const info = { ready: true, count: 3, pools: [{ pool: 0, name: '全部', count: 2 }] }
    const call = vi.fn().mockResolvedValue(info)
    expect(await corpusInfo(call)).toEqual(info)
    expect(call).toHaveBeenCalledWith(CORPUS_METHODS.info, {})
  })
  it('旧原生没有方法或未就绪当作 ready:false；其他错误照抛', async () => {
    expect(await corpusInfo(vi.fn().mockRejectedValue({ code: 'UNKNOWN_METHOD' }))).toEqual({ ready: false })
    expect(await corpusInfo(vi.fn().mockRejectedValue({ code: 'NOT_READY' }))).toEqual({ ready: false })
    await expect(corpusInfo(vi.fn().mockRejectedValue({ code: 'INTERNAL' }))).rejects.toEqual({ code: 'INTERNAL' })
  })
})

describe('corpusGet', () => {
  it('把池与下标传给原生', async () => {
    state.native = true
    const c = { id: 1, up: '甲', down: '乙', banner: '丙', cats: ['山水'], primary: '山水' }
    const call = vi.fn().mockResolvedValue(c)
    expect(await corpusGet(2, 9, call)).toEqual(c)
    expect(call).toHaveBeenCalledWith(CORPUS_METHODS.get, { pool: 2, index: 9 })
  })
  it('无宿主抛 NativeUnavailableError', async () => {
    state.native = false
    await expect(corpusGet(0, 0, vi.fn())).rejects.toBeInstanceOf(NativeUnavailableError)
  })
})
