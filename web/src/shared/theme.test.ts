import { describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import { applyDark, DARK_CLASS, DARK_QUERY, loadThemeMode, parseThemeMode, resolveDark, saveThemeMode, THEME_MODES, THEME_STORAGE_KEY } from './theme'

/** 内存存储 */
function memStorage(init: Record<string, string> = {}) {
  const data = { ...init }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v
    },
  }
}

describe('resolveDark', () => {
  it('显式亮/暗不看系统', () => {
    expect(resolveDark('light', true)).toBe(false)
    expect(resolveDark('dark', false)).toBe(true)
  })
  it('跟随系统取系统值', () => {
    expect(resolveDark('system', true)).toBe(true)
    expect(resolveDark('system', false)).toBe(false)
  })
})

describe('parseThemeMode / 持久化', () => {
  it('非法值回落到跟随系统', () => {
    for (const bad of [null, undefined, '', 'blue', 1, {}]) expect(parseThemeMode(bad)).toBe('system')
    for (const m of Object.values(THEME_MODES)) expect(parseThemeMode(m)).toBe(m)
  })
  it('存取往返，默认跟随系统', () => {
    const s = memStorage()
    expect(loadThemeMode(s)).toBe('system')
    saveThemeMode('dark', s)
    expect(s.data[THEME_STORAGE_KEY]).toBe('dark')
    expect(loadThemeMode(s)).toBe('dark')
  })
  it('存储不可用或抛错时静默', () => {
    const bad = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadThemeMode(bad)).toBe('system')
    expect(() => saveThemeMode('dark', bad)).not.toThrow()
    expect(loadThemeMode(undefined)).toBe('system')
  })
})

describe('applyDark', () => {
  it('切暗色类与 color-scheme', () => {
    const classes = new Set<string>()
    const root = {
      classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
      style: { colorScheme: '' },
    } as unknown as HTMLElement
    applyDark(true, root)
    expect(classes.has(DARK_CLASS)).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
    applyDark(false, root)
    expect(classes.has(DARK_CLASS)).toBe(false)
    expect(root.style.colorScheme).toBe('light')
  })
})

describe('public/theme-init.js 与 resolveDark 一致', () => {
  const raw = import.meta.glob('../../public/theme-init.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const src = Object.values(raw)[0]
  /** 把首帧脚本包成函数，注入假的全局对象 */
  const run = new Function('window', 'matchMedia', 'localStorage', 'document', src)

  /** 执行首帧脚本，返回是否挂了暗色类；getItem 可注入抛错 */
  function runInit(getItem: (k: string) => string | null, systemDark: boolean): boolean {
    let dark = false
    const matchMedia = (q: string) => ({ matches: q === DARK_QUERY && systemDark })
    run({ matchMedia }, matchMedia, { getItem }, { documentElement: { classList: { add: (c: string) => (dark = c === DARK_CLASS) }, style: {} } })
    return dark
  }

  it('全部组合结果相同', () => {
    for (const saved of [null, 'light', 'dark', 'system', 'junk']) {
      for (const systemDark of [false, true]) {
        const got = runInit((k) => (k === THEME_STORAGE_KEY ? saved : null), systemDark)
        expect(got, `${saved}/${systemDark}`).toBe(resolveDark(parseThemeMode(saved), systemDark))
      }
    }
  })
  it('存储抛错时按跟随系统', () => {
    const deny = () => {
      throw new Error('denied')
    }
    expect(runInit(deny, true)).toBe(true)
    expect(runInit(deny, false)).toBe(false)
  })
})
