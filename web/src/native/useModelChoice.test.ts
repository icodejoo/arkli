import { beforeEach, describe, expect, it } from 'vitest'
import { CHOICE_KEY_PREFIX } from '@/shared/modelPicker'
import { resetModelChoiceCache, useModelChoice } from './useModelChoice'

/** 测试用内存 localStorage */
function installStorage(init: Record<string, string> = {}): void {
  const m = new Map(Object.entries(init))
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  }
}

describe('useModelChoice', () => {
  beforeEach(() => resetModelChoiceCache())

  it('默认取工具声明的第一个 L1', () => {
    installStorage()
    expect(useModelChoice('waste-sort').choice.value).toBe('siglip2-q4_half')
  })
  it('没有声明模型的工具为 null', () => {
    installStorage()
    expect(useModelChoice('base64').choice.value).toBeNull()
  })
  it('set 后持久化，同工具共享', () => {
    installStorage()
    const a = useModelChoice('ocr')
    a.set('ocr')
    expect(useModelChoice('ocr').choice.value).toBe('ocr')
    expect(localStorage.getItem(CHOICE_KEY_PREFIX + 'ocr')).toBe('ocr')
  })
  it('存的值已失效则回落默认', () => {
    installStorage({ [CHOICE_KEY_PREFIX + 'ocr']: 'removed' })
    expect(useModelChoice('ocr').choice.value).toBe('ocr')
  })
})
