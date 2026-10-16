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
  ['aiUpscale', (m, c) => m.aiUpscale('p.jpg', 4, c), 'native.ai.upscale', { path: 'p.jpg', scale: 4 }, 'upscale'],
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
  it('aiFuse 不传 ratio 时不带该字段', async () => {
    const m = await load(true)
    const call = fakeCall(ALL_ON, {})
    await m.aiFuse('a', 'b', undefined, call)
    expect(call).toHaveBeenCalledWith('native.ai.fuse', { pathA: 'a', pathB: 'b' }, { timeoutMs: 0 })
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

describe('aiProviders / aiRun', () => {
  const SAMPLE = {
    providers: [{ id: 'intent-handoff', displayName: '系统应用交接', available: true, tasks: ['translate'] }],
    capabilities: ['translate'],
  }
  /** 造固定返回值的 call */
  const ret = (v: unknown) => vi.fn(async () => v) as unknown as Call & ReturnType<typeof vi.fn>
  /** 造抛错的 call */
  const boom = (code: string) =>
    vi.fn(async () => {
      throw { code }
    }) as unknown as Call

  it('aiProviders：有宿主走 native.ai.providers', async () => {
    const { aiProviders } = await load(true)
    const call = ret(SAMPLE)
    expect(await aiProviders(call)).toEqual(SAMPLE)
    expect(call).toHaveBeenCalledWith('native.ai.providers', {})
  })
  it('aiProviders：无宿主返回空且不调原生', async () => {
    const { aiProviders } = await load(false)
    const call = ret(SAMPLE)
    expect(await aiProviders(call)).toEqual({ providers: [], capabilities: [] })
    expect(call).not.toHaveBeenCalled()
  })
  it('aiProviders：UNKNOWN_METHOD 容错，其他错误照抛', async () => {
    const { aiProviders } = await load(true)
    expect(await aiProviders(boom('UNKNOWN_METHOD'))).toEqual({ providers: [], capabilities: [] })
    await expect(aiProviders(boom('INTERNAL'))).rejects.toMatchObject({ code: 'INTERNAL' })
  })
  it('aiProviders：新增的 layer / offers 原样透传', async () => {
    const { aiProviders } = await load(true)
    const v = {
      providers: [
        {
          id: 'local-nllb',
          displayName: 'NLLB',
          layer: 'L1',
          available: true,
          tasks: ['translate'],
          offers: [{ task: 'translate', entry: 'native.ai.translate', constraints: { languages: ['en', 'fr'], sourceAuto: true } }],
        },
      ],
      capabilities: ['translate'],
    }
    expect(await aiProviders(ret(v))).toEqual(v)
  })
  it('offerOf：按任务与入口取报价，旧原生没有 offers 视为没有', async () => {
    const { offerOf } = await load(true)
    const handoff = {
      id: 'intent-handoff',
      displayName: '交接',
      available: true,
      tasks: ['translate'] as const,
      offers: [{ task: 'translate' as const, entry: 'native.ai.run' }],
    }
    expect(offerOf({ ...handoff, tasks: [...handoff.tasks] }, 'translate')?.entry).toBe('native.ai.run')
    expect(offerOf({ ...handoff, tasks: [...handoff.tasks] }, 'translate', 'native.ai.translate')).toBeUndefined()
    expect(offerOf({ id: 'old', displayName: '旧', available: true, tasks: ['translate'] }, 'translate')).toBeUndefined()
  })
  it('aiRun：转调 native.ai.invoke 并钉住 run 入口，不设超时', async () => {
    const { aiRun, HANDOFF_PROVIDER_ID } = await load(true)
    const call = ret({ handoff: true, handled: false })
    expect(await aiRun(HANDOFF_PROVIDER_ID, 'translate', 'hello', call)).toEqual({ handoff: true, handled: false })
    expect(call).toHaveBeenCalledWith(
      'native.ai.invoke',
      { task: 'translate', input: { text: 'hello' }, provider: 'intent-handoff', entry: 'native.ai.run' },
      { timeoutMs: 0, signal: undefined },
    )
  })
  it('aiRun：无宿主抛 NativeUnavailableError；原生错误透传', async () => {
    const off = await load(false)
    await expect(off.aiRun('p', 'prompt', 'x', ret({}))).rejects.toMatchObject({ name: 'NativeUnavailableError' })
    const on = await load(true)
    await expect(on.aiRun('p', 'prompt', 'x', boom('NOT_READY'))).rejects.toMatchObject({ code: 'NOT_READY' })
  })
})

describe('aiClassifyImage（本地识物）', () => {
  const RESULT = {
    items: [{ id: 'milk_carton', nameZh: '牛奶利乐包', nameEn: 'milk carton', category: 'R', score: 0.31 }],
    categories: [{ category: 'R', name: '可回收物', prob: 0.97 }],
    confidence: 0.97,
    uncertain: false,
    elapsedMs: 1200,
    inferMs: 1000,
    modelId: 'siglip2-mnn-w8',
  }
  /** 只回结果的 call，不经过 status */
  const ok = () => vi.fn(async () => RESULT) as unknown as Call & ReturnType<typeof vi.fn>
  /** 抛指定错误码的 call */
  const fail = (code: string) =>
    vi.fn(async () => {
      throw { code, message: 'x' }
    }) as unknown as Call

  it('转调 native.ai.invoke 并钉住识图入口，不查 status，不设超时，默认 topK=3', async () => {
    const m = await load(true)
    const call = ok()
    expect(await m.aiClassifyImage('cache/pick/a.jpg', undefined, call)).toEqual(RESULT)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith(
      'native.ai.invoke',
      { task: 'classifyImage', input: { path: 'cache/pick/a.jpg' }, entry: 'native.ai.classify', options: { topK: 3 } },
      { timeoutMs: 0, signal: undefined },
    )
  })
  it('topK 放进 options 传递', async () => {
    const m = await load(true)
    const call = ok()
    await m.aiClassifyImage('p', 7, call)
    expect(call).toHaveBeenCalledWith(
      'native.ai.invoke',
      { task: 'classifyImage', input: { path: 'p' }, entry: 'native.ai.classify', options: { topK: 7 } },
      { timeoutMs: 0, signal: undefined },
    )
  })
  it('无宿主：抛 AiNotReadyError 且不调原生', async () => {
    const m = await load(false)
    const call = ok()
    await expect(m.aiClassifyImage('p', 3, call)).rejects.toBeInstanceOf(m.AiNotReadyError)
    expect(call).not.toHaveBeenCalled()
  })
  it('NOT_READY / UNKNOWN_METHOD 统一成 AiNotReadyError，其他错误照抛', async () => {
    const m = await load(true)
    await expect(m.aiClassifyImage('p', 3, fail('NOT_READY'))).rejects.toMatchObject({ name: 'AiNotReadyError', model: 'classify' })
    await expect(m.aiClassifyImage('p', 3, fail('UNKNOWN_METHOD'))).rejects.toBeInstanceOf(m.AiNotReadyError)
    await expect(m.aiClassifyImage('p', 3, fail('BAD_PARAMS'))).rejects.toMatchObject({ code: 'BAD_PARAMS' })
  })
})

describe('aiOcr（本地文字识别，第一个按统一协议新增的任务）', () => {
  const RESULT = {
    blocks: [{ text: '你好 Hello', box: [10, 10, 90, 10, 90, 30, 10, 30], score: 0.98 }],
    width: 1080,
    height: 2400,
    elapsedMs: 900,
    inferMs: 800,
    modelId: 'ppocrv6-small-mnn-fp16',
  }
  /** 只回结果的 call，不经过 status */
  const ok = () => vi.fn(async () => RESULT) as unknown as import('./ai').CancelableCallFn & ReturnType<typeof vi.fn>
  /** 抛指定错误码的 call */
  const fail = (code: string) =>
    vi.fn(async () => {
      throw { code, message: 'x' }
    }) as unknown as import('./ai').CancelableCallFn

  it('转调 native.ai.invoke 并钉住 ocr 入口，不查 status，不设超时并透传 signal', async () => {
    const m = await load(true)
    const call = ok()
    const ac = new AbortController()
    expect(await m.aiOcr('cache/pick/a.jpg', ac.signal, call)).toEqual(RESULT)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith(
      'native.ai.invoke',
      { task: 'ocr', input: { path: 'cache/pick/a.jpg' }, entry: 'native.ai.ocr' },
      { timeoutMs: 0, signal: ac.signal },
    )
  })
  it('无宿主：抛 AiNotReadyError 且不调原生', async () => {
    const m = await load(false)
    const call = ok()
    await expect(m.aiOcr('p', undefined, call)).rejects.toMatchObject({ name: 'AiNotReadyError', model: 'ocr' })
    expect(call).not.toHaveBeenCalled()
  })
  it('NOT_READY / UNKNOWN_METHOD 统一成 AiNotReadyError，其他错误照抛', async () => {
    const m = await load(true)
    await expect(m.aiOcr('p', undefined, fail('NOT_READY'))).rejects.toBeInstanceOf(m.AiNotReadyError)
    await expect(m.aiOcr('p', undefined, fail('UNKNOWN_METHOD'))).rejects.toBeInstanceOf(m.AiNotReadyError)
    await expect(m.aiOcr('p', undefined, fail('BAD_PARAMS'))).rejects.toMatchObject({ code: 'BAD_PARAMS' })
    await expect(m.aiOcr('p', undefined, fail('CANCELLED'))).rejects.toMatchObject({ code: 'CANCELLED' })
  })
  it('aiInvoke 的 ocr 任务强类型：输入只有 path', async () => {
    const m = await load(true)
    const call = ok()
    const r = await m.aiInvoke('ocr', { path: 'p' }, {}, call)
    expect(r.blocks[0].text).toBe('你好 Hello')
    expect(call).toHaveBeenCalledWith('native.ai.invoke', { task: 'ocr', input: { path: 'p' } }, { timeoutMs: 0, signal: undefined })
  })
})

describe('aiCouplet（本地对联，专用端口）', () => {
  const RESULT = { text: '春满乾坤福满门', elapsedMs: 180, modelId: 'couplet-gpt2-mnn-w6' }
  /** 只回结果的 call */
  const ok = () => vi.fn(async () => RESULT) as unknown as import('./ai').CancelableCallFn & ReturnType<typeof vi.fn>
  /** 抛指定错误码的 call */
  const fail = (code: string) =>
    vi.fn(async () => {
      throw { code, message: 'x' }
    }) as unknown as import('./ai').CancelableCallFn

  it('转调 native.ai.invoke 并钉住 couplet 入口，options 带采样参数，不设超时并透传 signal', async () => {
    const m = await load(true)
    const call = ok()
    const ac = new AbortController()
    expect(await m.aiCouplet('天增岁月人增寿', { temperature: 0, topK: 5, seed: 7 }, ac.signal, call)).toEqual(RESULT)
    expect(call).toHaveBeenCalledWith(
      'native.ai.invoke',
      { task: 'couplet', input: { text: '天增岁月人增寿' }, entry: 'native.ai.couplet', options: { temperature: 0, topK: 5, seed: 7 } },
      { timeoutMs: 0, signal: ac.signal },
    )
  })
  it('不传 options 时请求里不带 options 字段', async () => {
    const m = await load(true)
    const call = ok()
    await m.aiCouplet('春风', undefined, undefined, call)
    expect(call).toHaveBeenCalledWith('native.ai.invoke', { task: 'couplet', input: { text: '春风' }, entry: 'native.ai.couplet' }, { timeoutMs: 0, signal: undefined })
  })
  it('无宿主：抛 AiNotReadyError 且不调原生', async () => {
    const m = await load(false)
    const call = ok()
    await expect(m.aiCouplet('春风', {}, undefined, call)).rejects.toMatchObject({ name: 'AiNotReadyError', model: 'couplet' })
    expect(call).not.toHaveBeenCalled()
  })
  it('NOT_READY / UNKNOWN_METHOD 统一成 AiNotReadyError，BAD_PARAMS 与 CANCELLED 照抛', async () => {
    const m = await load(true)
    await expect(m.aiCouplet('春风', {}, undefined, fail('NOT_READY'))).rejects.toBeInstanceOf(m.AiNotReadyError)
    await expect(m.aiCouplet('春风', {}, undefined, fail('UNKNOWN_METHOD'))).rejects.toBeInstanceOf(m.AiNotReadyError)
    await expect(m.aiCouplet('abc', {}, undefined, fail('BAD_PARAMS'))).rejects.toMatchObject({ code: 'BAD_PARAMS' })
    await expect(m.aiCouplet('春风', {}, undefined, fail('CANCELLED'))).rejects.toMatchObject({ code: 'CANCELLED' })
  })
  it('aiInvoke 的 couplet 任务强类型：输入 text，结果 text / elapsedMs / modelId', async () => {
    const m = await load(true)
    const call = ok()
    const r = await m.aiInvoke('couplet', { text: '春风' }, {}, call)
    expect(r.text).toBe('春满乾坤福满门')
    expect(r.modelId).toBe('couplet-gpt2-mnn-w6')
    expect(call).toHaveBeenCalledWith('native.ai.invoke', { task: 'couplet', input: { text: '春风' } }, { timeoutMs: 0, signal: undefined })
  })
})

describe('aiTranslate', () => {
  const RES = { text: '你好', elapsedMs: 1200, modelId: 'nllb600m-un6-mnn-w6', src: 'en', tgt: 'zh-CN', detectedSrc: ['en'], unrecognized: false }
  const okT = () => vi.fn(async () => RES) as unknown as import('./ai').CancelableCallFn & ReturnType<typeof vi.fn>

  it('转调 native.ai.invoke 并钉住翻译入口，不设超时并透传 signal；缺省不带 numBeams 与 provider', async () => {
    const m = await load(true)
    const call = okT()
    const ac = new AbortController()
    expect(await m.aiTranslate({ text: 'hi', src: 'en', tgt: 'zh-CN' }, ac.signal, call)).toEqual(RES)
    expect(call).toHaveBeenCalledWith(
      'native.ai.invoke',
      { task: 'translate', input: { text: 'hi', src: 'en', tgt: 'zh-CN' }, entry: 'native.ai.translate' },
      { timeoutMs: 0, signal: ac.signal },
    )
  })
  it('src 为 auto：原样透传，结果带 detectedSrc 与 unrecognized', async () => {
    const m = await load(true)
    const res = { ...RES, src: 'auto', detectedSrc: ['fr', 'en'], unrecognized: true }
    const call = vi.fn(async () => res) as unknown as import('./ai').CancelableCallFn & ReturnType<typeof vi.fn>
    const r = await m.aiTranslate({ text: 'x', src: 'auto', tgt: 'zh-CN' }, undefined, call)
    expect(r.detectedSrc).toEqual(['fr', 'en'])
    expect(r.unrecognized).toBe(true)
    expect(call).toHaveBeenCalledWith(
      'native.ai.invoke',
      { task: 'translate', input: { text: 'x', src: 'auto', tgt: 'zh-CN' }, entry: 'native.ai.translate' },
      { timeoutMs: 0, signal: undefined },
    )
  })
  it('numBeams 有值时放进 options', async () => {
    const m = await load(true)
    const call = okT()
    await m.aiTranslate({ text: 'hi', src: 'en', tgt: 'fr', numBeams: 2 }, undefined, call)
    expect(call).toHaveBeenCalledWith(
      'native.ai.invoke',
      { task: 'translate', input: { text: 'hi', src: 'en', tgt: 'fr' }, entry: 'native.ai.translate', options: { numBeams: 2 } },
      { timeoutMs: 0, signal: undefined },
    )
  })
  it('provider 有值时放在顶层', async () => {
    const m = await load(true)
    const call = okT()
    await m.aiTranslate({ text: 'hi', src: 'en', tgt: 'fr', provider: 'local-qwen' }, undefined, call)
    expect(call).toHaveBeenCalledWith(
      'native.ai.invoke',
      { task: 'translate', input: { text: 'hi', src: 'en', tgt: 'fr' }, provider: 'local-qwen', entry: 'native.ai.translate' },
      { timeoutMs: 0, signal: undefined },
    )
  })
  it('无宿主：抛 NativeUnavailableError 且不调原生', async () => {
    const m = await load(false)
    const call = okT()
    await expect(m.aiTranslate({ text: 'hi', src: 'en', tgt: 'fr' }, undefined, call)).rejects.toMatchObject({ name: 'NativeUnavailableError' })
    expect(call).not.toHaveBeenCalled()
  })
  it('原生错误码原样抛出', async () => {
    const m = await load(true)
    const bad = vi.fn(async () => {
      throw { code: 'NOT_READY', message: 'x' }
    }) as unknown as import('./ai').CancelableCallFn
    await expect(m.aiTranslate({ text: 'hi', src: 'en', tgt: 'fr' }, undefined, bad)).rejects.toMatchObject({ code: 'NOT_READY' })
  })
})

describe('aiWarmup / aiUnload', () => {
  const mk = (v: unknown) => vi.fn(async () => v) as unknown as import('./ai').CancelableCallFn & ReturnType<typeof vi.fn>

  it('aiWarmup：带 provider，不设超时并透传 signal', async () => {
    const m = await load(true)
    const call = mk({ provider: 'local-nllb', loaded: true, elapsedMs: 5 })
    const ac = new AbortController()
    expect((await m.aiWarmup('local-nllb', ac.signal, call)).loaded).toBe(true)
    expect(call).toHaveBeenCalledWith('native.ai.warmup', { provider: 'local-nllb' }, { timeoutMs: 0, signal: ac.signal })
  })
  it('aiWarmup：无宿主抛 NativeUnavailableError，原生错误码原样抛', async () => {
    const off = await load(false)
    const call = mk({})
    await expect(off.aiWarmup('local-nllb', undefined, call)).rejects.toMatchObject({ name: 'NativeUnavailableError' })
    expect(call).not.toHaveBeenCalled()
    const on = await load(true)
    const bad = vi.fn(async () => {
      throw { code: 'UNKNOWN_METHOD' }
    }) as unknown as import('./ai').CancelableCallFn
    await expect(on.aiWarmup('local-nllb', undefined, bad)).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' })
  })
  it('aiUnload：有 provider 带上，缺省传空对象', async () => {
    const m = await load(true)
    const call = mk({ unloaded: ['local-nllb'] })
    expect(await m.aiUnload('local-nllb', call)).toEqual({ unloaded: ['local-nllb'] })
    expect(call).toHaveBeenLastCalledWith('native.ai.unload', { provider: 'local-nllb' })
    await m.aiUnload(undefined, call)
    expect(call).toHaveBeenLastCalledWith('native.ai.unload', {})
  })
  it('aiUnload：无宿主抛 NativeUnavailableError', async () => {
    const m = await load(false)
    await expect(m.aiUnload('local-nllb', mk({}))).rejects.toMatchObject({ name: 'NativeUnavailableError' })
  })
})

describe('aiInvoke（统一入口）', () => {
  const mk = (v: unknown) => vi.fn(async () => v) as unknown as import('./ai').CancelableCallFn & ReturnType<typeof vi.fn>

  it('只带有值的字段：缺省不带 provider / entry / options', async () => {
    const m = await load(true)
    const call = mk({ handoff: false, handled: true, text: '摘要' })
    const r = await m.aiInvoke('summarize', { text: '一大段' }, undefined, call)
    expect(r.text).toBe('摘要')
    expect(call).toHaveBeenCalledWith('native.ai.invoke', { task: 'summarize', input: { text: '一大段' } }, { timeoutMs: 0, signal: undefined })
  })
  it('文本生成选项（preset / system / temperature / topK）原样放进 options，类型按 AiTaskMap 强类型', async () => {
    const m = await load(true)
    const call = mk({ handoff: false, handled: true, text: '答' })
    const r = await m.aiInvoke(
      'prompt',
      { text: '你好' },
      { provider: 'local-qwen', options: { preset: 'prompt', system: '你是海盗', temperature: 0.3, topK: 10 } },
      call,
    )
    expect(r.text).toBe('答')
    expect(call).toHaveBeenCalledWith(
      'native.ai.invoke',
      {
        task: 'prompt',
        provider: 'local-qwen',
        input: { text: '你好' },
        options: { preset: 'prompt', system: '你是海盗', temperature: 0.3, topK: 10 },
      },
      { timeoutMs: 0, signal: undefined },
    )
    // 旧封装 aiRun 签名不变，不带生成选项
    const old = mk({ handoff: false, handled: true, text: 'x' })
    await m.aiRun('local-qwen', 'prompt', 'hi', old)
    expect(old).toHaveBeenCalledWith(
      'native.ai.invoke',
      { task: 'prompt', input: { text: 'hi' }, provider: 'local-qwen', entry: 'native.ai.run' },
      { timeoutMs: 0, signal: undefined },
    )
  })
  it('provider、entry、非空 options 与 signal 原样带上；空 options 省略', async () => {
    const m = await load(true)
    const call = mk({})
    const ac = new AbortController()
    await m.aiInvoke(
      'translate',
      { text: 'hi', src: 'en', tgt: 'fr' },
      { provider: 'local-qwen', entry: 'native.ai.translate', options: { numBeams: 1 }, signal: ac.signal },
      call,
    )
    expect(call).toHaveBeenLastCalledWith(
      'native.ai.invoke',
      { task: 'translate', input: { text: 'hi', src: 'en', tgt: 'fr' }, provider: 'local-qwen', entry: 'native.ai.translate', options: { numBeams: 1 } },
      { timeoutMs: 0, signal: ac.signal },
    )
    await m.aiInvoke('classifyImage', { path: 'p' }, { options: {} }, call)
    expect(call).toHaveBeenLastCalledWith('native.ai.invoke', { task: 'classifyImage', input: { path: 'p' } }, { timeoutMs: 0, signal: undefined })
  })
  it('无宿主抛 NativeUnavailableError 且不调原生；原生错误码原样抛', async () => {
    const off = await load(false)
    const call = mk({})
    await expect(off.aiInvoke('prompt', { text: 'x' }, {}, call)).rejects.toMatchObject({ name: 'NativeUnavailableError' })
    expect(call).not.toHaveBeenCalled()
    const on = await load(true)
    const bad = vi.fn(async () => {
      throw { code: 'NOT_READY', message: 'x' }
    }) as unknown as import('./ai').CancelableCallFn
    await expect(on.aiInvoke('prompt', { text: 'x' }, {}, bad)).rejects.toMatchObject({ code: 'NOT_READY' })
  })
})

describe('isAiCancelled', () => {
  it('识别原生 CANCELLED 与 AbortError，其余不算', async () => {
    const m = await load(false)
    expect(m.isAiCancelled({ code: m.AI_CODE_CANCELLED })).toBe(true)
    expect(m.isAiCancelled({ name: 'AbortError' })).toBe(true)
    expect(m.isAiCancelled({ code: 'INTERNAL' })).toBe(false)
    expect(m.isAiCancelled(null)).toBe(false)
  })
})
