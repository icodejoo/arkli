import { describe, expect, it } from 'vitest'
import { findTool, tools } from './registry'

/** 已注册的工具 id */
const KNOWN_ID = 'bridge-probe'

describe('findTool', () => {
  it('命中已注册的 id', () => {
    expect(findTool(KNOWN_ID)).toBe(tools.find((t) => t.id === KNOWN_ID))
    expect(findTool(KNOWN_ID)?.id).toBe(KNOWN_ID)
  })

  it('不存在的 id 返回 undefined', () => {
    expect(findTool('no-such-tool')).toBeUndefined()
  })

  it('空串返回 undefined', () => {
    expect(findTool('')).toBeUndefined()
  })

  it('大小写敏感', () => {
    expect(findTool(KNOWN_ID.toUpperCase())).toBeUndefined()
  })

  it('注册表里的 id 不重复', () => {
    const ids = tools.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
