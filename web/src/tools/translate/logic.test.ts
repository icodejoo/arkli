import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import { LANGS_KEY, LEGACY_LANGS_KEY } from './data'
import { defaultPair, isLatestRun, MSG_BAD_PARAMS, MSG_FAILED, MSG_NOT_READY, parsePair, readPair, swapPair, swapTexts, translateErrorMessage, writePair } from './logic'

/** 内存版存储后端 */
function memBackend(init: Record<string, string> = {}): StorageLike {
  const m = new Map<string, string>(Object.entries(init))
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
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
  it('parsePair：合法值通过，脏数据回落默认', () => {
    expect(parsePair('{"src":"fr","tgt":"es"}')).toEqual({ src: 'fr', tgt: 'es' })
    expect(parsePair(null)).toEqual(defaultPair())
    expect(parsePair('oops')).toEqual(defaultPair())
    expect(parsePair('{"src":"fr","tgt":"fr"}')).toEqual(defaultPair())
    expect(parsePair('{"src":"xx","tgt":"fr"}')).toEqual(defaultPair())
    expect(parsePair('{"src":"de","tgt":"ja"}')).toEqual({ src: 'de', tgt: 'ja' })
  })
  it('write 后 read 一致，键名固定', () => {
    const b = memBackend()
    const store = createToolStorage('translate', b)
    writePair(store, { src: 'ru', tgt: 'ar' })
    expect(b.getItem('translate_' + LANGS_KEY)).toBe('{"src":"ru","tgt":"ar"}')
    expect(readPair(store)).toEqual({ src: 'ru', tgt: 'ar' })
  })
  it('旧键一次性迁移', () => {
    const b = memBackend({ [LEGACY_LANGS_KEY]: '{"src":"fr","tgt":"es"}' })
    const store = createToolStorage('translate', b)
    expect(readPair(store)).toEqual({ src: 'fr', tgt: 'es' })
    expect(b.getItem(LEGACY_LANGS_KEY)).toBeNull()
  })
  it('缓存值非法时回落默认；后端不可用时不崩', () => {
    expect(readPair(createToolStorage('translate', memBackend({ ['translate_' + LANGS_KEY]: '{"src":"xx","tgt":"fr"}' })))).toEqual(defaultPair())
    const store = createToolStorage('translate', null)
    expect(() => writePair(store, defaultPair())).not.toThrow()
    expect(readPair(store)).toEqual(defaultPair())
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
  it('BAD_PARAMS 带原生中文原因（如超字数上限）时原样显示，英文技术消息仍用通用提示', () => {
    const msg = '该模型最多翻译 300 字，请改用本地翻译模型'
    expect(translateErrorMessage({ code: 'BAD_PARAMS', message: msg })).toBe(msg)
    expect(translateErrorMessage({ code: 'BAD_PARAMS', message: 'bad numBeams' })).toBe(MSG_BAD_PARAMS)
    expect(translateErrorMessage({ code: 'BAD_PARAMS' })).toBe(MSG_BAD_PARAMS)
    expect(translateErrorMessage({ code: 'INTERNAL', message: '中文也不显示' })).toBe(MSG_FAILED)
  })
  it('isLatestRun：序号被取消或新请求推进后，旧一轮不再是最新', () => {
    expect(isLatestRun(3, 3)).toBe(true)
    expect(isLatestRun(3, 4)).toBe(false)
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
