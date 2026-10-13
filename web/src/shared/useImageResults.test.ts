import { effectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vant', () => ({ showToast: vi.fn(), showFailToast: vi.fn(), showSuccessToast: vi.fn() }))

/** 打桩 URL 并加载模块 */
async function setup() {
  vi.resetModules()
  vi.stubGlobal('window', {})
  const revoked: string[] = []
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++n}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u))
  const vant = await import('vant')
  const { useImageResults } = await import('./useImageResults')
  const { ImageTooLargeError } = await import('./image-io')
  const scope = effectScope()
  const api = scope.run(() => useImageResults())!
  return { api, scope, revoked, vant, ImageTooLargeError }
}

/** 造一个产物草稿 */
const draft = (name: string) => ({ name, blob: new Blob(['x']), width: 1, height: 1 })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useImageResults.process', () => {
  it('串行处理，产物带 id 与 url；再次处理会回收旧 url', async () => {
    const { api, revoked } = await setup()
    expect(await api.process(['a', 'b'], async (n) => draft(n))).toBe(2)
    expect(api.results.value.map((r) => r.name)).toEqual(['a', 'b'])
    expect(api.results.value[0].url).toBe('blob:1')
    await api.process(['c'], async (n) => [draft(n), draft(`${n}2`)])
    expect(revoked).toEqual(['blob:1', 'blob:2'])
    expect(api.results.value).toHaveLength(2)
    expect(api.busy.value).toBe(false)
    expect(api.progress.value).toBe('')
  })

  it('单个失败不影响其余，并提示失败数', async () => {
    const { api, vant } = await setup()
    const n = await api.process(['a', 'bad', 'c'], async (x) => {
      if (x === 'bad') throw new Error('boom')
      return draft(x)
    })
    expect(n).toBe(2)
    expect(vant.showFailToast).toHaveBeenCalledWith('处理失败 1 张')
  })

  it('超限错误提示请先缩小', async () => {
    const { api, vant, ImageTooLargeError } = await setup()
    await api.process(['a'], async () => {
      throw new ImageTooLargeError(20000, 20000)
    })
    expect(vant.showToast).toHaveBeenCalledWith('图片过大，请先缩小')
  })

  it('作用域销毁时回收 url', async () => {
    const { api, scope, revoked } = await setup()
    await api.process(['a'], async (n) => draft(n))
    scope.stop()
    expect(revoked).toEqual(['blob:1'])
  })
})
