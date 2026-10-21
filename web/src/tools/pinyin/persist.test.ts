import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, sanitizeOptions } from './logic'

describe('pinyin 持久缓存', () => {
  it('合法缓存读回填，缺项补默认', () => {
    const o = sanitizeOptions({ tone: 'num', separator: '-', surname: true })
    expect(o).toEqual({ ...DEFAULT_OPTIONS, tone: 'num', separator: '-', surname: true })
  })
  it('非法缓存回落默认', () => {
    expect(sanitizeOptions(null)).toEqual(DEFAULT_OPTIONS)
    expect(sanitizeOptions({ tone: 'x', pattern: 1, separator: '@@', keepOther: 'y' })).toEqual(DEFAULT_OPTIONS)
  })
})
