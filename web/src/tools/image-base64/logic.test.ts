import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  bloatText,
  buildDataUrl,
  decodedSize,
  encodedLength,
  isValidBase64,
  normalizeBase64,
  parseBase64Input,
  sniffImageMime,
  stripDataUrlPrefix,
} from './logic'

describe('normalizeBase64', () => {
  it('去空白并补齐等号', () => {
    expect(normalizeBase64('YW Jj\n')).toBe('YWJj')
    expect(normalizeBase64('YQ')).toBe('YQ==')
  })
  it('URL 安全字符转标准', () => {
    expect(normalizeBase64('a-_b')).toBe('a+/b')
  })
  it('长度余 1 无法补齐，原样返回', () => {
    expect(normalizeBase64('abcde')).toBe('abcde')
  })
})

describe('isValidBase64', () => {
  it('合法与非法', () => {
    expect(isValidBase64('YWJj')).toBe(true)
    expect(isValidBase64('')).toBe(false)
    expect(isValidBase64('abcde')).toBe(false)
    expect(isValidBase64('ab!d')).toBe(false)
  })
})

describe('parseBase64Input', () => {
  it('完整 data URL', () => {
    expect(parseBase64Input('data:image/png;base64,YWJj')).toEqual({ mime: 'image/png', base64: 'YWJj' })
  })
  it('纯 Base64（含换行、缺填充）', () => {
    expect(parseBase64Input(' YW\nJjZA ')).toEqual({ mime: '', base64: 'YWJjZA==' })
  })
  it('非法内容返回 null', () => {
    expect(parseBase64Input('你好 world!')).toBeNull()
    expect(parseBase64Input('data:image/png;base64,')).toBeNull()
  })
})

describe('stripDataUrlPrefix / buildDataUrl', () => {
  it('互为逆操作', () => {
    const url = buildDataUrl('image/jpeg', 'AAAA')
    expect(url).toBe('data:image/jpeg;base64,AAAA')
    expect(stripDataUrlPrefix(url)).toBe('AAAA')
  })
  it('非 data URL 原样返回', () => {
    expect(stripDataUrlPrefix('AAAA')).toBe('AAAA')
  })
})

describe('体积计算', () => {
  it('decodedSize 扣除填充', () => {
    expect(decodedSize('YWJj')).toBe(3)
    expect(decodedSize('YWJjZA==')).toBe(4)
    expect(decodedSize('YWJjZGU=')).toBe(5)
    expect(decodedSize('')).toBe(0)
  })
  it('encodedLength', () => {
    expect(encodedLength(3)).toBe(4)
    expect(encodedLength(4)).toBe(8)
    expect(encodedLength(0)).toBe(0)
  })
  it('bloatText 约 +33%', () => {
    expect(bloatText(300, encodedLength(300))).toBe('+33%')
    expect(bloatText(0, 10)).toBe('--')
    expect(bloatText(100, 80)).toBe('-20%')
  })
})

describe('base64ToBytes', () => {
  it('解码', () => {
    expect(Array.from(base64ToBytes('YWJj'))).toEqual([97, 98, 99])
  })
})

describe('sniffImageMime', () => {
  it('常见格式', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]))).toBe('image/png')
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe('image/gif')
    expect(sniffImageMime(new Uint8Array([0x42, 0x4d, 0]))).toBe('image/bmp')
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    expect(sniffImageMime(webp)).toBe('image/webp')
  })
  it('认不出返回空串', () => {
    expect(sniffImageMime(new Uint8Array([1, 2, 3]))).toBe('')
    expect(sniffImageMime(new Uint8Array([]))).toBe('')
  })
})
