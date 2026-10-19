import type { AiProviderInfo } from '@/native/ai'
import { describe, expect, it } from 'vitest'
import type { AiParamSpec } from '@/native/ai'
import {
  formatApplyToText,
  formatParamValue,
  isModified,
  selectIndex,
  selectValue,
  splitSpecs,
  paramProvidersOf,
} from './modelParams'

describe('modelParams 纯逻辑', () => {
  const baseSpec: AiParamSpec = {
    key: 'temperature',
    label: '采样温度',
    desc: '控制发散程度',
    kind: 'slider',
    default: 0.7,
    min: 0,
    max: 1.5,
    step: 0.1,
    advanced: false,
    scope: 'call',
  }

  describe('formatApplyToText', () => {
    it('空值或空数组返回空字符串', () => {
      expect(formatApplyToText(undefined)).toBe('')
      expect(formatApplyToText([])).toBe('')
    })

    it('单个已收录项映射为中文', () => {
      expect(formatApplyToText(['prompt'])).toBe('只对：问答 生效')
    })

    it('多项使用顿号连接且未收录项原样显示', () => {
      expect(formatApplyToText(['prompt', 'customTask', 'summarize'])).toBe('只对：问答、customTask、摘要 生效')
    })
  })

  describe('isModified', () => {
    it('当前值等于默认值或为 undefined 时返回 false', () => {
      expect(isModified(baseSpec, undefined)).toBe(false)
      expect(isModified(baseSpec, 0.7)).toBe(false)
      // 容差范围内的微小浮点误差不判定为修改
      expect(isModified(baseSpec, 0.7000000001)).toBe(false)
    })

    it('当前值不同于默认值时返回 true', () => {
      expect(isModified(baseSpec, 0.8)).toBe(true)
      expect(isModified(baseSpec, 0)).toBe(true)
    })
  })

  describe('formatParamValue', () => {
    it('slider 依据 step 的小数位数格式化数值', () => {
      expect(formatParamValue(baseSpec, 0.7)).toBe('0.7')
      expect(formatParamValue(baseSpec, 0.7000000002)).toBe('0.7')
      expect(formatParamValue({ ...baseSpec, step: 1 }, 4)).toBe('4')
      expect(formatParamValue({ ...baseSpec, step: 0.05 }, 0.25)).toBe('0.25')
    })

    it('select 类型依据 options 和下标格式化', () => {
      const selectSpec: AiParamSpec = {
        key: 'power',
        label: '功耗',
        desc: '性能模式',
        kind: 'select',
        default: 0,
        min: 0,
        max: 2,
        step: 1,
        options: ['均衡', '性能', '省电'],
        advanced: false,
        scope: 'session',
      }
      expect(formatParamValue(selectSpec, 0)).toBe('均衡')
      expect(formatParamValue(selectSpec, 1)).toBe('性能')
      expect(formatParamValue(selectSpec, 2)).toBe('省电')
      expect(formatParamValue(selectSpec, 99)).toBe('99')
    })
  })

  describe('select 带 optionValues', () => {
    const beams: AiParamSpec = {
      key: 'numBeams',
      label: '束宽',
      desc: 'd',
      kind: 'select',
      default: 1,
      min: 1,
      max: 4,
      step: 1,
      options: ['快速', '均衡', '精细'],
      optionValues: [1, 2, 4],
      advanced: false,
      scope: 'call',
    }

    it('按真实值显示档位名与取下标', () => {
      expect(formatParamValue(beams, 4)).toBe('精细')
      expect(selectIndex(beams, 2)).toBe(1)
      expect(selectIndex(beams, 3)).toBe(-1)
    })

    it('点第几档提交对应真实值；没有 optionValues 时提交下标', () => {
      expect(selectValue(beams, 2)).toBe(4)
      expect(selectValue({ ...beams, optionValues: undefined }, 2)).toBe(2)
    })
  })

  describe('splitSpecs', () => {
    it('正确将 specs 分离为普通组和高级组', () => {
      const advancedSpec: AiParamSpec = { ...baseSpec, key: 'topK', advanced: true }
      const res = splitSpecs([baseSpec, advancedSpec])
      expect(res.basic).toEqual([baseSpec])
      expect(res.advanced).toEqual([advancedSpec])
    })
  })
})

describe('paramProvidersOf', () => {
  const spec = { key: 'k', label: 'k', desc: '', kind: 'slider', default: 0, min: 0, max: 1, step: 0.1, advanced: false, scope: 'call' } as const
  const mk = (id: string, modelId: string | undefined, params?: AiProviderInfo['params']): AiProviderInfo => ({ id, displayName: id, available: true, tasks: [], modelId, params })
  it('只返回 modelId 一致且带 params 的提供者', () => {
    const list = [mk('a', 'm1', [spec]), mk('b', 'm1'), mk('c', 'm2', [spec]), mk('d', 'm1', [])]
    expect(paramProvidersOf(list, 'm1').map((p) => p.id)).toEqual(['a'])
    expect(paramProvidersOf(list, 'none')).toEqual([])
  })
})
