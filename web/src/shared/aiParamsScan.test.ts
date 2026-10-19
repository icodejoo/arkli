import { describe, expect, it } from 'vitest'

/** 工具页里禁止出现的参数相关引用 */
const FORBIDDEN = [/native\.ai\.params/, /\bparamsGet\b/, /\bparamsSet\b/, /\bparamsReset\b/, /stores\/aiParams/, /\buseAiParamsStore\b/]

describe('项目规则：工具页不得读写 AI 可调参数', () => {
  it('web/src/tools/ 下（不含测试）没有 native.ai.params / paramsGet|Set|Reset / aiParams store', () => {
    const files = import.meta.glob('../tools/**/*.{vue,ts}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const bad = Object.entries(files)
      .filter(([p]) => !/\.test\.ts$/.test(p))
      .filter(([, src]) => FORBIDDEN.some((re) => re.test(src)))
      .map(([p]) => p)
    expect(bad).toEqual([])
  })
})
