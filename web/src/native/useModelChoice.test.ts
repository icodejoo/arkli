import { beforeEach, describe, expect, it } from 'vitest'
import { CHOICE_KEY_PREFIX, CHOICE_NS } from '@/shared/modelPicker'
import { resetModelChoiceCache, useModelChoice } from './useModelChoice'

/** 测试用内存 localStorage，返回底层 Map 便于断言写回 */
function installStorage(init: Record<string, string> = {}): Map<string, string> {
  const m = new Map(Object.entries(init))
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
  return m
}

describe('useModelChoice', () => {
  beforeEach(() => resetModelChoiceCache())

  it('默认取工具第一个过渡清单模型迁移后的值（识物已有提供者，存提供者 id）', () => {
    installStorage()
    expect(useModelChoice('waste-sort').choice.value).toBe('local-clip')
    expect(useModelChoice('image-upscale').choice.value).toBe('model:image-upscale')
  })
  it('没有声明模型的工具为 null；只声明任务的工具在目录探测前也为 null', () => {
    installStorage()
    expect(useModelChoice('base64').choice.value).toBeNull()
    expect(useModelChoice('translate').choice.value).toBeNull()
  })
  it('set 后持久化，同工具共享', () => {
    installStorage()
    const a = useModelChoice('translate')
    a.set('local-qwen')
    expect(useModelChoice('translate').choice.value).toBe('local-qwen')
    expect(localStorage.getItem(CHOICE_NS + '_translate')).toBe('"local-qwen"')
  })
  it('旧值（清单模型 id）读到时迁移成新值并写回', () => {
    const m = installStorage({
      [CHOICE_KEY_PREFIX + 'translate']: 'qwen35-0.8b-mnn-q4',
      [CHOICE_KEY_PREFIX + 'waste-sort']: 'siglip2-q4_half',
      [CHOICE_KEY_PREFIX + 'ocr']: 'ocr',
    })
    expect(useModelChoice('translate').choice.value).toBe('local-qwen')
    expect(useModelChoice('waste-sort').choice.value).toBe('local-clip')
    expect(useModelChoice('ocr').choice.value).toBe('local-ocr')
    expect(m.get(CHOICE_NS + '_ocr')).toBe('"local-ocr"')
    expect(m.get(CHOICE_NS + '_translate')).toBe('"local-qwen"')
    expect(m.get(CHOICE_NS + '_waste-sort')).toBe('"local-clip"')
  })
  it('认不出的值原样保留（有效性由目录在运行时判断并回落），不在这里改写', () => {
    const m = installStorage({ [CHOICE_KEY_PREFIX + 'ocr']: 'removed' })
    expect(useModelChoice('ocr').choice.value).toBe('removed')
    expect(m.get(CHOICE_NS + '_ocr')).toBe('"removed"')
  })
  it('迁移表标记丢弃的值：回到静态默认，不写回', () => {
    const m = installStorage({ [CHOICE_KEY_PREFIX + 'waste-sort']: 'l2-none' })
    expect(useModelChoice('waste-sort').choice.value).toBe('local-clip')
    expect(m.get(CHOICE_NS + '_waste-sort')).toBe('"l2-none"')
  })
})
