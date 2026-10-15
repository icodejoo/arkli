import { beforeEach, describe, expect, it } from 'vitest'
import { LANGS_STORAGE_KEY } from './data'
import { defaultPair, isCancelled, MSG_BAD_PARAMS, MSG_FAILED, MSG_NOT_READY, parsePair, readPair, swapPair, swapTexts, translateErrorMessage, writePair } from './logic'

/** 内存版 localStorage（node 环境没有） */
function stubStorage(): void {
  const m = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  } as unknown as Storage
}

describe('语言选择（页面部分）', () => {
  it('默认 en -> zh-CN', () => {
    expect(defaultPair()).toEqual({ src: 'en', tgt: 'zh-CN' })
  })
  it('swapPair 交换两侧', () => {
    expect(swapPair({ src: 'en', tgt: 'ru' })).toEqual({ src: 'ru', tgt: 'en' })
  })
})

describe('存取', () => {
  beforeEach(stubStorage)
  it('parsePair：合法值通过，脏数据回落默认', () => {
    expect(parsePair('{"src":"fr","tgt":"es"}')).toEqual({ src: 'fr', tgt: 'es' })
    expect(parsePair(null)).toEqual(defaultPair())
    expect(parsePair('oops')).toEqual(defaultPair())
    expect(parsePair('{"src":"fr","tgt":"fr"}')).toEqual(defaultPair())
    expect(parsePair('{"src":"xx","tgt":"fr"}')).toEqual(defaultPair())
    expect(parsePair('{"src":"de","tgt":"ja"}')).toEqual({ src: 'de', tgt: 'ja' })
  })
  it('write 后 read 一致，键名固定', () => {
    writePair({ src: 'ru', tgt: 'ar' })
    expect(localStorage.getItem(LANGS_STORAGE_KEY)).toBe('{"src":"ru","tgt":"ar"}')
    expect(readPair()).toEqual({ src: 'ru', tgt: 'ar' })
  })
  it('storage 抛错时不崩，读回默认', () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('x')
      },
      setItem: () => {
        throw new Error('x')
      },
    } as unknown as Storage
    expect(() => writePair(defaultPair())).not.toThrow()
    expect(readPair()).toEqual(defaultPair())
  })
})

describe('错误归类', () => {
  it('按错误码给人话', () => {
    expect(translateErrorMessage({ code: 'NOT_READY' })).toBe(MSG_NOT_READY)
    expect(translateErrorMessage({ code: 'BAD_PARAMS' })).toBe(MSG_BAD_PARAMS)
    expect(translateErrorMessage({ code: 'INTERNAL' })).toBe(MSG_FAILED)
    expect(translateErrorMessage(new Error('x'))).toBe(MSG_FAILED)
    expect(translateErrorMessage(null)).toBe(MSG_FAILED)
  })
  it('isCancelled 识别 CANCELLED 与 AbortError', () => {
    expect(isCancelled({ code: 'CANCELLED' })).toBe(true)
    expect(isCancelled({ name: 'AbortError' })).toBe(true)
    expect(isCancelled({ code: 'INTERNAL' })).toBe(false)
  })
})

describe('swapTexts', () => {
  it('有译文就交换输入与译文', () => {
    expect(swapTexts('Hello', '你好', 2000)).toEqual({ input: '你好', result: 'Hello' })
  })
  it('没有译文时输入保持不动，译文仍为空', () => {
    expect(swapTexts('Hello', '', 2000)).toEqual({ input: 'Hello', result: '' })
  })
  it('译文超过输入上限时截断', () => {
    expect(swapTexts('a', 'b'.repeat(10), 4)).toEqual({ input: 'bbbb', result: 'a' })
  })
})
