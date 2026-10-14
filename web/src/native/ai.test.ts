import { afterEach, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('./ai')
type Call = import('./ai').CallFn

/** 带（或不带）宿主地加载一份全新的 ai */
async function load(withHost: boolean): Promise<Mod> {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  return import('./ai')
}

/** 造 call：status 返回 models，其余方法返回 ret 或抛 err */
function fakeCall(models: Record<string, boolean>, ret: unknown, err?: unknown) {
  const fn = vi.fn(async (method: string) => {
    if (method === 'native.ai.status') return { models }
    if (err) throw err
    return ret
  })
  return fn as unknown as Call & typeof fn
}

const ALL_ON = { ocr: true, upscale: true, classify: true, matte: true, fuse: true, colorize: true }

afterEach(() => vi.unstubAllGlobals())

describe('getAiStatus', () => {
  it('有宿主：合并原生返回', async () => {
    const { getAiStatus } = await load(true)
    const s = await getAiStatus(fakeCall({ ocr: true }, null))
    expect(s.models.ocr).toBe(true)
    expect(s.models.upscale).toBe(false)
  })
  it('无宿主：全 false 且不调原生', async () => {
    const { getAiStatus } = await load(false)
    const call = fakeCall(ALL_ON, null)
    const s = await getAiStatus(call)
    expect(Object.values(s.models).every((v) => !v)).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })
  it('UNKNOWN_METHOD 容错为全 false，其他错误照抛', async () => {
    const { getAiStatus } = await load(true)
    const bad = vi.fn(async () => {
      throw { code: 'UNKNOWN_METHOD', message: 'x' }
    }) as unknown as Call
    expect((await getAiStatus(bad)).models.ocr).toBe(false)
    const boom = vi.fn(async () => {
      throw { code: 'INTERNAL', message: 'x' }
    }) as unknown as Call
    await expect(getAiStatus(boom)).rejects.toMatchObject({ code: 'INTERNAL' })
  })
})

/** 每个封装的调用与期望参数 */
const CASES: Array<[string, (m: Mod, c: Call) => Promise<unknown>, string, Record<string, unknown>, string]> = [
  ['aiOcr', (m, c) => m.aiOcr('p.jpg', 'en', c), 'native.ai.ocr', { path: 'p.jpg', lang: 'en' }, 'ocr'],
  ['aiUpscale', (m, c) => m.aiUpscale('p.jpg', 4, c), 'native.ai.upscale', { path: 'p.jpg', scale: 4 }, 'upscale'],
  ['aiClassify', (m, c) => m.aiClassify('p.jpg', 3, c), 'native.ai.classify', { path: 'p.jpg', topK: 3 }, 'classify'],
  ['aiMatte', (m, c) => m.aiMatte('p.jpg', c), 'native.ai.matte', { path: 'p.jpg' }, 'matte'],
  ['aiFuse', (m, c) => m.aiFuse('a', 'b', 0.3, c), 'native.ai.fuse', { pathA: 'a', pathB: 'b', ratio: 0.3 }, 'fuse'],
  ['aiColorize', (m, c) => m.aiColorize('p.jpg', c), 'native.ai.colorize', { path: 'p.jpg' }, 'colorize'],
]

describe.each(CASES)('%s', (_n, run, method, params, model) => {
  it('有宿主且就绪：带参数调用并返回结果', async () => {
    const m = await load(true)
    const call = fakeCall(ALL_ON, { ok: 1 })
    expect(await run(m, call)).toEqual({ ok: 1 })
    expect(call).toHaveBeenCalledWith(method, params, { timeoutMs: 0 })
  })
  it('无宿主：抛 AiNotReadyError', async () => {
    const m = await load(false)
    const err = (await run(m, fakeCall(ALL_ON, 1)).catch((e) => e)) as { model: string; message: string }
    expect(err).toBeInstanceOf(m.AiNotReadyError)
    expect(err.model).toBe(model)
    expect(err.message).toBe('模型未就绪')
  })
  it('UNKNOWN_METHOD：抛 AiNotReadyError', async () => {
    const m = await load(true)
    const call = fakeCall(ALL_ON, null, { code: 'UNKNOWN_METHOD', message: 'x' })
    await expect(run(m, call)).rejects.toBeInstanceOf(m.AiNotReadyError)
  })
  it('NOT_READY 或 status 为 false：抛 AiNotReadyError', async () => {
    const m = await load(true)
    await expect(run(m, fakeCall(ALL_ON, null, { code: 'NOT_READY', message: 'x' }))).rejects.toBeInstanceOf(m.AiNotReadyError)
    const call = fakeCall({}, 1)
    await expect(run(m, call)).rejects.toBeInstanceOf(m.AiNotReadyError)
    expect(call).not.toHaveBeenCalledWith(method, expect.anything(), expect.anything())
  })
})

describe('其他', () => {
  it('其他原生错误原样抛出', async () => {
    const m = await load(true)
    await expect(m.aiMatte('p', fakeCall(ALL_ON, null, { code: 'INTERNAL', message: 'x' }))).rejects.toMatchObject({ code: 'INTERNAL' })
  })
  it('aiFuse 不传 ratio 时不带该字段，aiClassify 默认 topK=5', async () => {
    const m = await load(true)
    const call = fakeCall(ALL_ON, {})
    await m.aiFuse('a', 'b', undefined, call)
    expect(call).toHaveBeenCalledWith('native.ai.fuse', { pathA: 'a', pathB: 'b' }, { timeoutMs: 0 })
    await m.aiClassify('p', undefined, call)
    expect(call).toHaveBeenLastCalledWith('native.ai.classify', { path: 'p', topK: 5 }, { timeoutMs: 0 })
  })
  it('aiOcr 默认 zh', async () => {
    const m = await load(true)
    const call = fakeCall(ALL_ON, {})
    await m.aiOcr('p', undefined, call)
    expect(call).toHaveBeenLastCalledWith('native.ai.ocr', { path: 'p', lang: 'zh' }, { timeoutMs: 0 })
  })
  it('fetchAiResult 拼 /files/ 前缀，失败抛错', async () => {
    const m = await load(false)
    const blob = new Blob(['x'])
    const ok = vi.fn(async () => ({ ok: true, blob: async () => blob })) as unknown as typeof fetch
    expect(await m.fetchAiResult('cache/out/a.png', ok)).toBe(blob)
    expect(ok).toHaveBeenCalledWith('/files/cache/out/a.png')
    const bad = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch
    await expect(m.fetchAiResult('x', bad)).rejects.toThrow('读取结果失败')
  })
})
