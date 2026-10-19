import { describe, expect, it } from 'vitest'
import {
  NAME_INPUT_MAX,
  SYSTEM_MAX,
  TEMPERATURE,
  TEXT_INPUT_MAX,
  WRITER_MODES,
  buildRequest,
  buildSystem,
  clampInput,
  inputLimit,
  isListMode,
  parseCandidates,
  validateInput,
} from './logic'

describe('clampInput', () => {
  it('未超长原样返回（去首尾空白）', () => {
    expect(clampInput('  abc ', 10)).toEqual({ text: 'abc', truncated: false })
  })
  it('超长截断并标记', () => {
    expect(clampInput('abcdef', 3)).toEqual({ text: 'abc', truncated: true })
  })
})

describe('buildSystem', () => {
  it('每种模式都在原生 system 上限内且非空', () => {
    for (const { key } of WRITER_MODES) {
      const s = buildSystem(key, 'shop', '高端')
      expect(s.length).toBeGreaterThan(0)
      expect(s.length).toBeLessThanOrEqual(SYSTEM_MAX)
    }
  })
  it('起名带类别与风格，风格会被限长', () => {
    expect(buildSystem('name', 'pet', '可爱')).toContain('宠物名')
    expect(buildSystem('name', 'pet', '可爱')).toContain('风格：可爱')
    expect(buildSystem('name', 'person')).not.toContain('风格')
    expect(buildSystem('name', 'person', 'x'.repeat(500)).length).toBeLessThan(SYSTEM_MAX)
  })
  it('各模式提示词互不相同', () => {
    const set = new Set(WRITER_MODES.map((m) => buildSystem(m.key)))
    expect(set.size).toBe(WRITER_MODES.length)
  })
})

describe('buildRequest', () => {
  it('温度按模式取值', () => {
    expect(buildRequest({ mode: 'polish', input: '你好' }).temperature).toBe(TEMPERATURE.polish)
    expect(buildRequest({ mode: 'name', input: '咖啡店' }).temperature).toBe(TEMPERATURE.name)
  })
  it('起名与长文用各自的输入上限', () => {
    expect(inputLimit('name')).toBe(NAME_INPUT_MAX)
    expect(inputLimit('expand')).toBe(TEXT_INPUT_MAX)
    const r = buildRequest({ mode: 'shrink', input: '字'.repeat(TEXT_INPUT_MAX + 50) })
    expect(r.text.length).toBe(TEXT_INPUT_MAX)
    expect(r.truncated).toBe(true)
    expect(r.inputMax).toBe(TEXT_INPUT_MAX)
  })
  it('最大输入远低于原生 50000 上限', () => {
    expect(TEXT_INPUT_MAX).toBeLessThan(50000)
  })
})

describe('validateInput', () => {
  it('空白不可提交，提示随模式', () => {
    expect(validateInput({ mode: 'name', input: ' ' })).toContain('起名')
    expect(validateInput({ mode: 'title', input: '' })).toBe('先写点内容')
    expect(validateInput({ mode: 'title', input: '内容' })).toBeNull()
  })
})

describe('parseCandidates', () => {
  it('去序号、符号、引号', () => {
    expect(parseCandidates('1. 云间\n2、“山海”\n- 《星河》\n3) 晚风')).toEqual(['云间', '山海', '星河', '晚风'])
  })
  it('去重、丢空行、限个数', () => {
    expect(parseCandidates('1. a\n\n2. a\n3. b\n4. c', 2)).toEqual(['a', 'b'])
  })
  it('没有序号的纯文本行也保留', () => {
    expect(parseCandidates('小满\n大暑')).toEqual(['小满', '大暑'])
  })
})

describe('isListMode', () => {
  it('起名与起标题按列表展示', () => {
    expect(isListMode('name')).toBe(true)
    expect(isListMode('title')).toBe(true)
    expect(isListMode('polish')).toBe(false)
  })
})
