import { describe, expect, it } from 'vitest'

/** 所有 vue / ts 源码的原文，路径为 key（vitest 会把 scss 内容清空，所以样式放在 .vue 的 <style> 里才扫得到） */
const sources = import.meta.glob('/src/**/*.{vue,ts}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** 允许直接写 env(safe-area-inset-*) 的文件：只有本测试自己（全局变量定义在 styles/index.scss，不在扫描范围） */
const ALLOWED = ['/src/styles/safe-area.test.ts']

describe('安全区', () => {
  it('页面样式一律读 --safe-* 变量，不直接写 env(safe-area-inset-*)', () => {
    // 原生（边到边）把系统栏尺寸推到 <html> 的 --safe-* 变量里；
    // 直接写 env() 在 WebView 里拿不到状态栏高度，页面会被状态栏盖住
    const offenders = Object.entries(sources)
      .filter(([path]) => !ALLOWED.includes(path))
      .filter(([, text]) => /env\(\s*safe-area-inset/.test(text))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  it('扫描确实覆盖到了页面源码（防止 glob 失效导致上面的断言空转）', () => {
    expect(Object.keys(sources).some((p) => p.endsWith('/views/HomeView.vue'))).toBe(true)
    expect(Object.keys(sources).length).toBeGreaterThan(50)
  })
})
