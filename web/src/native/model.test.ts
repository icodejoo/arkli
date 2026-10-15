import { afterEach, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('./model')
type Call = import('./model').CallFn

/** 带（或不带）宿主地加载一份全新的 model */
async function load(withHost: boolean): Promise<Mod> {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  return import('./model')
}

/** 造 call，返回固定值 */
function fakeCall(ret: unknown) {
  return vi.fn(async () => ret) as unknown as Call & ReturnType<typeof vi.fn>
}

afterEach(() => vi.unstubAllGlobals())

describe('modelList', () => {
  it('有宿主：取 models 数组', async () => {
    const { modelList } = await load(true)
    const call = fakeCall({ models: [{ id: 'a' }] })
    expect(await modelList(call)).toEqual([{ id: 'a' }])
    expect(call).toHaveBeenCalledWith('native.model.list', {})
  })
  it('无宿主：空列表且不调原生', async () => {
    const { modelList } = await load(false)
    const call = fakeCall({ models: [{ id: 'a' }] })
    expect(await modelList(call)).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })
  it('UNKNOWN_METHOD 容错为空，其他错误照抛', async () => {
    const { modelList } = await load(true)
    const unknown = vi.fn(async () => {
      throw { code: 'UNKNOWN_METHOD', message: 'x' }
    }) as unknown as Call
    expect(await modelList(unknown)).toEqual([])
    const boom = vi.fn(async () => {
      throw { code: 'INTERNAL', message: 'x' }
    }) as unknown as Call
    await expect(modelList(boom)).rejects.toMatchObject({ code: 'INTERNAL' })
  })
  it('原生没给 models 字段：空列表', async () => {
    const { modelList } = await load(true)
    expect(await modelList(fakeCall({}))).toEqual([])
  })
})

describe('单模型方法', () => {
  /** 方法、调用、期望原生方法名、是否不设超时 */
  const CASES: Array<[string, (m: Mod, c: Call) => Promise<unknown>, string, boolean]> = [
    ['modelStatus', (m, c) => m.modelStatus('x', c), 'native.model.status', false],
    ['modelEnsure', (m, c) => m.modelEnsure('x', c), 'native.model.ensure', false],
    ['modelCancel', (m, c) => m.modelCancel('x', c), 'native.model.cancel', false],
    ['modelRemove', (m, c) => m.modelRemove('x', c), 'native.model.remove', true],
    ['modelVerify', (m, c) => m.modelVerify('x', c), 'native.model.verify', true],
  ]

  for (const [name, run, method, noTimeout] of CASES) {
    it(`${name}：只传 id，返回原生结果`, async () => {
      const mod = await load(true)
      const call = fakeCall({ id: 'x', state: 'absent' })
      expect(await run(mod, call)).toEqual({ id: 'x', state: 'absent' })
      const args = call.mock.calls[0] as unknown[]
      expect(args[0]).toBe(method)
      expect(args[1]).toEqual({ id: 'x' })
      expect(args[2]).toEqual(noTimeout ? { timeoutMs: 0 } : undefined)
    })
    it(`${name}：无宿主抛 NativeUnavailableError 且不调原生`, async () => {
      const mod = await load(false)
      const call = fakeCall({})
      await expect(run(mod, call)).rejects.toMatchObject({ name: 'NativeUnavailableError', method })
      expect(call).not.toHaveBeenCalled()
    })
    it(`${name}：原生错误原样抛出`, async () => {
      const mod = await load(true)
      const call = vi.fn(async () => {
        throw { code: 'BAD_PARAMS', message: '未知的模型 id' }
      }) as unknown as Call
      await expect(run(mod, call)).rejects.toMatchObject({ code: 'BAD_PARAMS' })
    })
  }

  it('MODEL_METHODS 与桥协议方法名一致', async () => {
    const { MODEL_METHODS } = await load(true)
    expect(Object.values(MODEL_METHODS).sort()).toEqual(
      ['native.model.cancel', 'native.model.ensure', 'native.model.list', 'native.model.remove', 'native.model.status', 'native.model.verify'].sort(),
    )
  })
})
