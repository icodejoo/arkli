import { describe, expect, it } from 'vitest'
import { lookupPhrase, normalizePhrase } from './phrases'
import { isPairSupported, isUltraShort, routeShort, SHORT_WORDS_MAX, SHORT_ZH_MAX, type ShortRouteInput } from './shortInput'

describe('isUltraShort', () => {
  it('阈值常量', () => {
    expect(SHORT_ZH_MAX).toBe(4)
    expect(SHORT_WORDS_MAX).toBe(2)
  })
  it('中文按字符数，边界 4 字', () => {
    expect(isUltraShort('你好', 'zh-CN')).toBe(true)
    expect(isUltraShort('你好世界！', 'zh-CN')).toBe(true)
    expect(isUltraShort('今天天气好', 'zh-CN')).toBe(false)
  })
  it('内部有分隔标点不算极短', () => {
    expect(isUltraShort('你好，世界！', 'zh-CN')).toBe(false)
    expect(isUltraShort('Hello, world', 'en')).toBe(false)
  })
  it('其他语言按词数', () => {
    expect(isUltraShort('Good morning.', 'en')).toBe(true)
    expect(isUltraShort('How are you', 'en')).toBe(false)
  })
  it('auto 含汉字按中文，否则按词', () => {
    expect(isUltraShort('救命', 'auto')).toBe(true)
    expect(isUltraShort('Help', 'auto')).toBe(true)
    expect(isUltraShort('我今天很开心', 'auto')).toBe(false)
  })
  it('空串或纯标点为 false', () => {
    expect(isUltraShort('  ', 'en')).toBe(false)
    expect(isUltraShort('！！', 'zh-CN')).toBe(false)
  })
})

describe('lookupPhrase', () => {
  it('规整：忽略空白、大小写、末尾标点', () => {
    expect(normalizePhrase(' Hello! ')).toBe('hello')
    expect(lookupPhrase(' 你好！ ', 'zh-CN', 'en')).toBe('Hello')
    expect(lookupPhrase('THANK YOU.', 'en', 'zh-CN')).toBe('谢谢')
  })
  it('各条目', () => {
    expect(lookupPhrase('你好世界', 'zh-CN', 'en')).toBe('Hello, world')
    expect(lookupPhrase('不客气', 'zh-CN', 'en')).toBe("You're welcome")
    expect(lookupPhrase('救命', 'zh-CN', 'en')).toBe('Help')
    expect(lookupPhrase('How are you?', 'en', 'zh-CN')).toBe('你好吗')
  })
  it('auto 源按目标语言选表', () => {
    expect(lookupPhrase('再见', 'auto', 'en')).toBe('Goodbye')
    expect(lookupPhrase('Goodbye', 'auto', 'zh-CN')).toBe('再见')
  })
  it('未收录或语言对不对为 null', () => {
    expect(lookupPhrase('你好，世界！', 'zh-CN', 'en')).toBeNull()
    expect(lookupPhrase('你好', 'zh-CN', 'fr')).toBeNull()
    expect(lookupPhrase('你好', 'en', 'zh-CN')).toBeNull()
    expect(lookupPhrase('', 'zh-CN', 'en')).toBeNull()
  })
})

describe('routeShort', () => {
  const base: ShortRouteInput = { provider: 'local-nllb', text: '你好吗朋友', src: 'zh-CN', tgt: 'en', qwenReady: true, qwenSupportsPair: true }
  it('命中短语表直接出译文（即便 Qwen 未装）', () => {
    expect(routeShort({ ...base, text: '你好', qwenReady: false })).toEqual({ kind: 'phrase', text: 'Hello' })
  })
  it('极短未命中且 Qwen 就绪支持：改用 Qwen', () => {
    expect(routeShort({ ...base, text: '好吗' })).toEqual({ kind: 'qwen' })
  })
  it('Qwen 未装或不支持语言对：按所选', () => {
    expect(routeShort({ ...base, text: '好吗', qwenReady: false })).toEqual({ kind: 'selected' })
    expect(routeShort({ ...base, text: '好吗', qwenSupportsPair: false })).toEqual({ kind: 'selected' })
  })
  it('不极短：按所选', () => {
    expect(routeShort({ ...base, text: '你好，世界！' })).toEqual({ kind: 'selected' })
  })
  it('用户自选 Qwen 或其他提供者：不改写', () => {
    expect(routeShort({ ...base, provider: 'local-qwen', text: '你好' })).toEqual({ kind: 'selected' })
    expect(routeShort({ ...base, provider: undefined, text: '你好' })).toEqual({ kind: 'selected' })
  })
})

describe('isPairSupported', () => {
  const c = { languages: ['en', 'zh-CN'], sourceAuto: false }
  it('源与目标都在清单内', () => {
    expect(isPairSupported(c, { src: 'zh-CN', tgt: 'en' })).toBe(true)
    expect(isPairSupported(c, { src: 'zh-CN', tgt: 'fr' })).toBe(false)
  })
  it('auto 源要求支持自动检测', () => {
    expect(isPairSupported(c, { src: 'auto', tgt: 'en' })).toBe(false)
    expect(isPairSupported({ ...c, sourceAuto: true }, { src: 'auto', tgt: 'en' })).toBe(true)
  })
  it('没有约束视为不支持', () => {
    expect(isPairSupported(undefined, { src: 'en', tgt: 'zh-CN' })).toBe(false)
  })
})
