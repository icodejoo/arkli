import { afterEach, describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import { getSpeechStatus, onSpeechFinal, onSpeechPartial, speechErrorMessage, startSpeech, stopSpeech } from './speech'
import { NativeUnavailableError, type CallFn } from './system'

/** 造一个记录调用并返回固定值的 call */
function fakeCall(ret: unknown) {
  const fn = vi.fn(async () => ret)
  return fn as unknown as CallFn & typeof fn
}

/** 假宿主：让 isNativeAvailable 为真 */
function withHost() {
  vi.stubGlobal('window', { ArkliNative: { postMessage: vi.fn(), onmessage: null } })
}

afterEach(() => vi.unstubAllGlobals())

describe('speech', () => {
  it('无宿主：status 返回不可用，start / stop 抛 NativeUnavailableError', async () => {
    const s = await getSpeechStatus()
    expect(s.available).toBe(false)
    expect(s.reason).toBeTruthy()
    await expect(startSpeech()).rejects.toBeInstanceOf(NativeUnavailableError)
    await expect(stopSpeech()).rejects.toBeInstanceOf(NativeUnavailableError)
  })
  it('status：原样返回原生结果；调用失败降级为不可用', async () => {
    const ok = { available: true, engine: 'local-zipformer', modelReady: true }
    expect(await getSpeechStatus(fakeCall(ok), () => true)).toEqual(ok)
    const bad = vi.fn(async () => {
      throw { code: 'NOT_READY', message: '没模型' }
    }) as unknown as CallFn
    const s = await getSpeechStatus(bad, () => true)
    expect(s).toMatchObject({ available: false, modelReady: false, reason: '没模型' })
  })
  it('start：不超时地调用，返回采样率与任务号', async () => {
    withHost()
    const call = fakeCall({ started: true, sampleRate: 16000, taskId: 't1' })
    expect(await startSpeech({ lang: 'zh-en' }, call)).toEqual({ sampleRate: 16000, taskId: 't1' })
    expect(call).toHaveBeenCalledWith('native.speech.start', { lang: 'zh-en' }, { timeoutMs: 0 })
  })
  it('stop：返回整段文本，缺失时为空串', async () => {
    withHost()
    expect(await stopSpeech(fakeCall({ text: '你好' }))).toEqual({ text: '你好' })
    expect(await stopSpeech(fakeCall({}))).toEqual({ text: '' })
  })
  it('事件订阅：按事件名订阅、取出 text、可取消', () => {
    const off = vi.fn()
    const handlers: Record<string, (d: unknown) => void> = {}
    const on = vi.fn((e: string, h: (d: unknown) => void) => {
      handlers[e] = h
      return off
    })
    const partial: string[] = []
    const fin: string[] = []
    const o1 = onSpeechPartial((t) => partial.push(t), on)
    const o2 = onSpeechFinal((t) => fin.push(t), on)
    handlers['speech.partial']({ text: '你' })
    handlers['speech.final']({ text: '你好。' })
    handlers['speech.final'](null)
    expect(partial).toEqual(['你'])
    expect(fin).toEqual(['你好。', ''])
    o1()
    o2()
    expect(off).toHaveBeenCalledTimes(2)
  })
  it('speechErrorMessage：权限、未就绪、其他', () => {
    expect(speechErrorMessage({ code: 'PERMISSION_DENIED', message: 'x' })).toContain('麦克风权限')
    expect(speechErrorMessage({ code: 'NOT_READY', message: '模型未就绪' })).toBe('模型未就绪')
    expect(speechErrorMessage({ code: 'NOT_READY' })).toBe('语音识别暂不可用')
    expect(speechErrorMessage(new Error('boom'))).toBe('boom')
    expect(speechErrorMessage(null)).toBe('语音识别出错了')
  })
})
