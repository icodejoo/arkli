import { describe, expect, it } from 'vitest'
import { formatError } from './format-error'

describe('formatError', () => {
  it('有 code 和 message 时输出 CODE: message', () => {
    expect(formatError({ code: 'TIMEOUT', message: '超时' })).toBe('TIMEOUT: 超时')
  })

  it('有 code 无 message 时 message 部分为空', () => {
    expect(formatError({ code: 'NOT_READY' })).toBe('NOT_READY: ')
  })

  it('message 为 null 时同样当空串处理', () => {
    expect(formatError({ code: 'X', message: null })).toBe('X: ')
  })

  it('普通 Error 没有 code，走 String()', () => {
    expect(formatError(new Error('boom'))).toBe('Error: boom')
  })

  it('字符串、数字原样转文本', () => {
    expect(formatError('oops')).toBe('oops')
    expect(formatError(42)).toBe('42')
  })

  it('null / undefined 不抛异常', () => {
    expect(formatError(null)).toBe('null')
    expect(formatError(undefined)).toBe('undefined')
  })

  it('code 为空串视为没有 code', () => {
    expect(formatError({ code: '', message: 'm' })).toBe('[object Object]')
  })
})
