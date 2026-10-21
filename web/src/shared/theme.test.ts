import { describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import { createToolStorage } from './toolStorage'
import { applyDark, DARK_CLASS, DARK_QUERY, LEGACY_THEME_KEY, loadThemeMode, parseThemeMode, resolveDark, saveThemeMode, THEME_MODES, THEME_STORAGE_KEY } from './theme'

/** 内存存储（带 ToolStorage 所需的 key/length/removeItem） */
function memBackend(init: Record<string, string> = {}) {
  const data = { ...init }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v
    },
    removeItem: (k: string) => {
      delete data[k]
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    get length() {
      return Object.keys(data).length
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
    const b = memBackend()
    const s = createToolStorage('app', b)
    expect(loadThemeMode(s)).toBe('system')
    saveThemeMode('dark', s)
    expect(b.data[THEME_STORAGE_KEY]).toBe('"dark"')
    expect(loadThemeMode(s)).toBe('dark')
  })
  it('旧键迁移：读到旧值并写入新键、删旧键', () => {
    const b = memBackend({ [LEGACY_THEME_KEY]: 'light' })
    expect(loadThemeMode(createToolStorage('app', b))).toBe('light')
    expect(b.data[THEME_STORAGE_KEY]).toBe('"light"')
    expect(b.data[LEGACY_THEME_KEY]).toBeUndefined()
  })
  it('缓存里是非法值：回落跟随系统', () => {
    const b = memBackend({ [THEME_STORAGE_KEY]: '"blue"' })
    expect(loadThemeMode(createToolStorage('app', b))).toBe('system')
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
    const s = createToolStorage('app', { ...bad, key: () => null, length: 0, removeItem: () => undefined })
    expect(loadThemeMode(s)).toBe('system')
    expect(() => saveThemeMode('dark', s)).not.toThrow()
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
        const got = runInit((k) => (k === THEME_STORAGE_KEY && saved != null ? JSON.stringify(saved) : null), systemDark)
        expect(got, `${saved}/${systemDark}`).toBe(resolveDark(parseThemeMode(saved), systemDark))
      }
    }
  })
  it('新键缺失时首帧兼容旧键原文，不闪', () => {
    expect(runInit((k) => (k === LEGACY_THEME_KEY ? 'dark' : null), false)).toBe(true)
    expect(runInit((k) => (k === LEGACY_THEME_KEY ? 'light' : null), true)).toBe(false)
  })
  it('存储抛错时按跟随系统', () => {
    const deny = () => {
      throw new Error('denied')
    }
    expect(runInit(deny, true)).toBe(true)
    expect(runInit(deny, false)).toBe(false)
  })
})
