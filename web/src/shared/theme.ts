/**
 * 主题设置：亮色 / 暗色 / 跟随系统。
 * 模式持久化在 localStorage，首帧由 public/theme-init.js 读取同一个键；切换后同步通知原生（状态栏图标、原生页面）。
 */
import { ref } from 'vue'
import { setNativeTheme } from '@/native/theme'

/** 主题模式取值（原生侧 ThemeMode 同名同值，各自一处定义） */
export const THEME_MODES = {
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system',
} as const

/** 主题模式 */
export type ThemeMode = (typeof THEME_MODES)[keyof typeof THEME_MODES]

/** localStorage 里存主题模式的键（public/theme-init.js 里也写了同一个字面量，theme.test.ts 会核对一致） */
export const THEME_STORAGE_KEY = 'arkli.theme'
/** Vant 暗色主题的 class 名 */
export const DARK_CLASS = 'van-theme-dark'
/** 深色模式媒体查询 */
export const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 键值存储的最小形状，便于单测注入 */
export interface ThemeStorage {
  /** 读 */
  getItem(key: string): string | null
  /** 写 */
  setItem(key: string, value: string): void
}

/**
 * 把任意值规范成合法模式。
 *
 * @param raw 原始值（存储读出的字符串等）
 * @returns 合法模式；不认识的值回落到跟随系统
 * @example parseThemeMode('dark') // 'dark'
 */
export function parseThemeMode(raw: unknown): ThemeMode {
  return raw === THEME_MODES.LIGHT || raw === THEME_MODES.DARK ? raw : THEME_MODES.SYSTEM
}

/**
 * 解析实际是否暗色（纯函数）。
 *
 * @param mode 主题模式
 * @param systemDark 系统当前是否深色
 * @returns true 为暗色
 * @example resolveDark('system', true) // true
 */
export function resolveDark(mode: ThemeMode, systemDark: boolean): boolean {
  if (mode === THEME_MODES.LIGHT) return false
  if (mode === THEME_MODES.DARK) return true
  return systemDark
}

/** 取浏览器 localStorage；不可用（隐私模式等）返回 undefined */
function defaultStorage(): ThemeStorage | undefined {
  try {
    return localStorage
  } catch {
    return undefined
  }
}

/**
 * 读已存的模式；没存过、存储不可用或数据非法都回落到跟随系统。
 *
 * @param storage 存储，默认 localStorage
 * @returns 主题模式
 */
export function loadThemeMode(storage: ThemeStorage | undefined = defaultStorage()): ThemeMode {
  try {
    return parseThemeMode(storage?.getItem(THEME_STORAGE_KEY))
  } catch {
    return THEME_MODES.SYSTEM
  }
}

/**
 * 写模式；存储不可用时静默忽略（本次会话内仍然生效）。
 *
 * @param mode 主题模式
 * @param storage 存储，默认 localStorage
 */
export function saveThemeMode(mode: ThemeMode, storage: ThemeStorage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // 降级为只在内存里
  }
}

/**
 * 把暗色状态落到根元素：切 Vant 暗色类，并同步 color-scheme（原生表单控件、滚动条跟着变）。
 *
 * @param dark 是否暗色
 * @param root 根元素，默认 document.documentElement
 */
export function applyDark(dark: boolean, root: HTMLElement = document.documentElement): void {
  root.classList.toggle(DARK_CLASS, dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
}

/** 当前主题模式（响应式，设置页绑定它） */
export const themeMode = ref<ThemeMode>(loadThemeMode())

/** 系统深浅色监听器，initTheme 时创建 */
let mql: MediaQueryList | undefined

/** 按当前模式与系统深浅色刷新页面 */
function refresh(): void {
  applyDark(resolveDark(themeMode.value, !!mql?.matches))
}

/**
 * 切换主题：立即生效、持久化并通知原生。
 *
 * @param mode 主题模式
 * @example setThemeMode('dark')
 */
export function setThemeMode(mode: ThemeMode): void {
  themeMode.value = mode
  saveThemeMode(mode)
  refresh()
  void setNativeTheme(mode)
}

/**
 * 启动主题：按已存模式刷新页面、监听系统深浅色变化（跟随系统时才会影响结果）、把模式告诉原生。
 *
 * @returns 取消监听的函数
 * @example const stop = initTheme()
 */
export function initTheme(): () => void {
  themeMode.value = loadThemeMode()
  const current = window.matchMedia(DARK_QUERY)
  mql = current
  refresh()
  current.addEventListener('change', refresh)
  void setNativeTheme(themeMode.value)
  return () => current.removeEventListener('change', refresh)
}
