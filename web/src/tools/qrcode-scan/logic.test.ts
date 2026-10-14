import { describe, expect, it } from 'vitest'
import type { QrResult } from '@/native/qrcode'
import { displayText, formatLabel, isOpenableUrl, mergeResults } from './logic'

/** 造一个识别结果 */
function qr(text: string, format = 'QR_CODE', bytes = text): QrResult {
  return { text, format, bytes }
}

describe('formatLabel', () => {
  it('已收录的给中文名，未收录的原样返回', () => {
    expect(formatLabel('QR_CODE')).toBe('二维码')
    expect(formatLabel('EAN_13')).toBe('EAN-13 条码')
    expect(formatLabel('DX_FILM_EDGE')).toBe('DX_FILM_EDGE')
  })
})

describe('isOpenableUrl', () => {
  it('http/https 且无空白才算网址', () => {
    expect(isOpenableUrl('https://example.com/a?b=1')).toBe(true)
    expect(isOpenableUrl('  HTTP://a.cn ')).toBe(true)
  })
  it('其它协议与普通文本都不算', () => {
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false)
    expect(isOpenableUrl('intent://x')).toBe(false)
    expect(isOpenableUrl('https://a.com 你好')).toBe(false)
    expect(isOpenableUrl('hello')).toBe(false)
    expect(isOpenableUrl('')).toBe(false)
  })
})

describe('mergeResults', () => {
  it('同码种同内容去重并保持顺序', () => {
    const a = qr('a')
    const b = qr('b')
    expect(mergeResults([a], [a, b])).toEqual([a, b])
  })
  it('同内容不同码种视为两个', () => {
    expect(mergeResults([qr('1', 'EAN_13'), qr('1', 'QR_CODE')])).toHaveLength(2)
  })
  it('没有字节时按文本比较', () => {
    expect(mergeResults([qr('x', 'QR_CODE', ''), qr('x', 'QR_CODE', '')])).toHaveLength(1)
  })
})

describe('displayText', () => {
  it('空文本给提示，否则原样', () => {
    expect(displayText(qr('', 'QR_CODE', 'AA=='))).toContain('二进制')
    expect(displayText(qr('你好'))).toBe('你好')
  })
})
