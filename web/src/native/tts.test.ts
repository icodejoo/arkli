import { afterEach, describe, expect, it, vi } from 'vitest'

/** 带（或不带）宿主地加载一份全新的 tts 与 system */
async function load(withHost: boolean, extra: Record<string, unknown> = {}) {
  vi.resetModules()
  vi.stubGlobal('window', withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {})
  for (const [k, v] of Object.entries(extra)) vi.stubGlobal(k, v)
  const tts = await import('./tts')
  const system = await import('./system')
  return { ...tts, NativeUnavailableError: system.NativeUnavailableError }
}

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as import('./system').CallFn & typeof fn
}

/** 假朗读语句的形状 */
interface FakeUtterance {
  text: string
  lang: string
  rate: number
  pitch: number
  onend: (() => void) | null
  onerror: (() => void) | null
}

/** 造一个假的浏览器朗读环境，spoken 里是依次朗读的语句，可手动触发结束 */
function fakeBrowser(voices: Array<{ lang: string }> = []) {
  const spoken: FakeUtterance[] = []
  const synth = { speak: vi.fn((u: FakeUtterance) => spoken.push(u)), cancel: vi.fn(), getVoices: () => voices }
  class Utter {
    lang = ''
    rate = 1
    pitch = 1
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(public text: string) {}
  }
  return { spoken, synth, extra: { speechSynthesis: synth, SpeechSynthesisUtterance: Utter } }
}

afterEach(() => vi.unstubAllGlobals())

describe('tts 有宿主', () => {
  it('speak：只带给了的字段，返回任务 id', async () => {
    const { speak } = await load(true)
    const call = fakeCall({ id: 's1' })
    expect(await speak({ text: '你好' }, call)).toBe('s1')
    expect(call).toHaveBeenCalledWith('native.tts.speak', { text: '你好' })
    await speak({ text: 'a', lang: 'en-US', rate: 1.5, pitch: 0.8 }, call)
    expect(call).toHaveBeenLastCalledWith('native.tts.speak', { text: 'a', lang: 'en-US', rate: 1.5, pitch: 0.8 })
  })
  it('stop / status / save', async () => {
    const { stopSpeaking, ttsStatus, saveSpeech } = await load(true)
    const stop = fakeCall({ stopped: true })
    await stopSpeaking(stop)
    expect(stop).toHaveBeenCalledWith('native.tts.stop')
    expect(await ttsStatus(fakeCall({ available: true, langs: ['zh-CN'] }))).toEqual({ available: true, langs: ['zh-CN'] })
    const save = fakeCall({ path: 'cache/out/a.wav', name: 'a.wav' })
    expect(await saveSpeech({ text: 'x', lang: 'zh-CN' }, save)).toEqual({ path: 'cache/out/a.wav', name: 'a.wav' })
    expect(save).toHaveBeenCalledWith('native.tts.save', { text: 'x', lang: 'zh-CN' }, { timeoutMs: 120000 })
  })
  it('onTtsEvent：把原生事件转成 TtsEvent，取消订阅时两路都退订', async () => {
    const { onTtsEvent } = await load(true)
    const handlers: Record<string, (d: unknown) => void> = {}
    const offs = { 'tts.done': vi.fn(), 'tts.stopped': vi.fn() }
    const on = vi.fn((event: string, h: (d: unknown) => void) => {
      handlers[event] = h
      return offs[event as keyof typeof offs]
    })
    const got: unknown[] = []
    const off = onTtsEvent((e) => got.push(e), on)
    handlers['tts.done']({ id: 's1' })
    handlers['tts.stopped']({ id: 's2', error: true })
    expect(got).toEqual([
      { type: 'done', id: 's1' },
      { type: 'stopped', id: 's2', error: true },
    ])
    off()
    expect(offs['tts.done']).toHaveBeenCalled()
    expect(offs['tts.stopped']).toHaveBeenCalled()
  })
})

describe('tts 无宿主', () => {
  it('没有 speechSynthesis：speak 抛错、status 不可用、save 抛错', async () => {
    const m = await load(false, { speechSynthesis: undefined, SpeechSynthesisUtterance: undefined })
    await expect(m.speak({ text: 'a' })).rejects.toBeInstanceOf(m.NativeUnavailableError)
    expect(await m.ttsStatus()).toEqual({ available: false, langs: [] })
    await expect(m.saveSpeech({ text: 'a' })).rejects.toBeInstanceOf(m.NativeUnavailableError)
  })
  it('浏览器朗读：读完推 done，被新朗读顶掉或停止推 stopped', async () => {
    const b = fakeBrowser([{ lang: 'zh_CN' }, { lang: 'en-US' }, { lang: 'zh-CN' }])
    const m = await load(false, b.extra)
    const got: unknown[] = []
    const off = m.onTtsEvent((e) => got.push(e), () => () => undefined)
    const id1 = await m.speak({ text: '你好', rate: 1.2 })
    expect(b.spoken[0]).toMatchObject({ text: '你好', lang: 'zh-CN', rate: 1.2, pitch: 1 })
    b.spoken[0].onend?.()
    expect(got).toEqual([{ type: 'done', id: id1 }])
    const id2 = await m.speak({ text: 'a' })
    const id3 = await m.speak({ text: 'b' })
    expect(got[1]).toEqual({ type: 'stopped', id: id2 })
    await m.stopSpeaking()
    expect(got[2]).toEqual({ type: 'stopped', id: id3 })
    expect(b.synth.cancel).toHaveBeenCalled()
    expect(await m.ttsStatus()).toEqual({ available: true, langs: ['en-US', 'zh-CN'] })
    off()
  })
  it('浏览器朗读出错：带 error 标记', async () => {
    const b = fakeBrowser()
    const m = await load(false, b.extra)
    const got: unknown[] = []
    m.onTtsEvent((e) => got.push(e), () => () => undefined)
    const id = await m.speak({ text: 'a' })
    b.spoken[0].onerror?.()
    expect(got).toEqual([{ type: 'stopped', id, error: true }])
  })
})
