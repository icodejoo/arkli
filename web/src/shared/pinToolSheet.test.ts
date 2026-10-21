import { describe, expect, it, vi } from 'vitest'
import { tools } from '@/tools/registry'
import {
  COPY_LINK_ACTION_LABEL,
  FLOAT_ACTION_LABEL,
  ICON_FLOAT,
  MENU_KEY_FLOAT,
  floatReplaceMessage,
  ICON_LINK,
  ICON_PACKAGE,
  ICON_REFRESH,
  ICON_SETTINGS,
  ICON_SHARE,
  ICON_SMARTPHONE,
  ICON_STAR,
  ICON_STAR_OFF,
  MENU_KEY_APK,
  MENU_KEY_COPY_LINK,
  MENU_KEY_LINK,
  MENU_KEY_PIN,
  MENU_KEY_REFRESH,
  MENU_KEY_SETTINGS,
  MENU_KEY_STAR,
  PIN_ACTION_LABEL,
  PIN_CANCEL_TEXT,
  PIN_FAILED_TOAST,
  PIN_REQUESTED_TOAST,
  PIN_SHEET_ACTIONS,
  PIN_UNSUPPORTED_TOAST,
  REFRESH_ACTION_LABEL,
  SETTINGS_ACTION_LABEL,
  SHARE_APK_ACTION_LABEL,
  SHARE_LINK_ACTION_LABEL,
  STAR_ACTION_LABEL,
  UNSTAR_ACTION_LABEL,
  buildMenuActions,
  buildToolDeepLink,
  formatPinDescription,
  pinErrorToast,
  pinResultToast,
  refreshApp,
} from './pinToolSheet'
import { shareIconSrc } from './shareSheetIcons'

/** 视图源码原文，供守卫测试扫描 */
const views = import.meta.glob('/src/views/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('buildMenuActions', () => {
  it('有宿主：两行，key 顺序固定', () => {
    const a = buildMenuActions(true, false)
    expect(a).toHaveLength(2)
    expect(a[0].map((x) => x.key)).toEqual([MENU_KEY_LINK, MENU_KEY_APK, MENU_KEY_STAR, MENU_KEY_PIN, MENU_KEY_FLOAT])
    expect(a[1].map((x) => x.key)).toEqual([MENU_KEY_REFRESH, MENU_KEY_COPY_LINK, MENU_KEY_SETTINGS])
  })
  it('无宿主：第一行没有添加到桌面', () => {
    const a = buildMenuActions(false, false)
    expect(a[0].map((x) => x.key)).toEqual([MENU_KEY_LINK, MENU_KEY_APK, MENU_KEY_STAR, MENU_KEY_FLOAT])
    expect(a.flat().some((x) => x.key === MENU_KEY_PIN)).toBe(false)
  })
  it('收藏项文案与图标随状态切换', () => {
    const star = (v: boolean) => buildMenuActions(false, v)[0].find((x) => x.key === MENU_KEY_STAR)
    expect(star(false)).toEqual({ name: STAR_ACTION_LABEL, key: MENU_KEY_STAR, icon: ICON_STAR })
    expect(star(true)).toEqual({ name: UNSTAR_ACTION_LABEL, key: MENU_KEY_STAR, icon: ICON_STAR_OFF })
  })
  it('各项文案与图标', () => {
    const [r1, r2] = buildMenuActions(true, false)
    expect(r1[0]).toEqual({ name: SHARE_LINK_ACTION_LABEL, key: MENU_KEY_LINK, icon: ICON_SHARE })
    expect(r1[1]).toEqual({ name: SHARE_APK_ACTION_LABEL, key: MENU_KEY_APK, icon: ICON_PACKAGE })
    expect(r1[3]).toEqual({ name: PIN_ACTION_LABEL, key: MENU_KEY_PIN, icon: ICON_SMARTPHONE })
    expect(r1[4]).toEqual({ name: FLOAT_ACTION_LABEL, key: MENU_KEY_FLOAT, icon: ICON_FLOAT })
    expect(r2[0]).toEqual({ name: REFRESH_ACTION_LABEL, key: MENU_KEY_REFRESH, icon: ICON_REFRESH })
    expect(r2[1]).toEqual({ name: COPY_LINK_ACTION_LABEL, key: MENU_KEY_COPY_LINK, icon: ICON_LINK })
    expect(r2[2]).toEqual({ name: SETTINGS_ACTION_LABEL, key: MENU_KEY_SETTINGS, icon: ICON_SETTINGS })
  })
  it('复制链接与分享下载链接图标不同', () => {
    expect(ICON_LINK).not.toBe(ICON_SHARE)
  })
})

describe('浮窗菜单项', () => {
  it('图标已登记成 data URI，且带专属色', () => {
    const src = shareIconSrc(ICON_FLOAT)
    expect(src.startsWith('data:image/svg+xml')).toBe(true)
    expect(decodeURIComponent(src)).toContain('#d6409f')
  })
  it('替换确认文案带上旧浮窗名', () => {
    expect(floatReplaceMessage('番茄钟')).toBe('已有浮窗「番茄钟」，浮起新的会关闭它')
  })
  it('拍平后每行 5 个：有宿主 8 项排成 5 + 3', () => {
    expect(buildMenuActions(true, false).flat()).toHaveLength(8)
  })
})

describe('buildToolDeepLink', () => {
  it('合法 id 拼出深链', () => {
    expect(buildToolDeepLink('ruler')).toBe('https://icodejoo.github.io/arkli/t/ruler')
    expect(buildToolDeepLink('color-picker')).toBe('https://icodejoo.github.io/arkli/t/color-picker')
  })
  it('非法 id 抛错', () => {
    for (const bad of ['', 'Ruler', 'a/b', 'a b', '尺子', '-ruler', 'ruler-', 'a--b']) {
      expect(() => buildToolDeepLink(bad)).toThrow('非法工具 id')
    }
  })
  it('注册表里所有工具 id 都合法', () => {
    expect(tools.length).toBeGreaterThan(0)
    for (const t of tools) expect(() => buildToolDeepLink(t.id)).not.toThrow()
  })
})

describe('refreshApp', () => {
  it('调用注入的 reload', () => {
    const reload = vi.fn()
    refreshApp(reload)
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it('默认走 window.location.reload', () => {
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })
    try {
      refreshApp()
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('固定结果文案', () => {
  it('requested 映射', () => {
    expect(pinResultToast({ requested: true })).toBe(PIN_REQUESTED_TOAST)
    expect(pinResultToast({ requested: false })).toBe(PIN_UNSUPPORTED_TOAST)
  })
  it('异常映射', () => {
    expect(pinErrorToast(new Error('x'))).toBe('x')
    expect(pinErrorToast('y')).toBe(PIN_FAILED_TOAST)
  })
  it('文案与原行为一致', () => {
    expect(PIN_REQUESTED_TOAST).toBe('请在系统弹窗里确认添加')
    expect(PIN_UNSUPPORTED_TOAST).toBe('当前桌面不支持添加快捷方式')
    expect(PIN_FAILED_TOAST).toBe('添加失败')
    expect(PIN_CANCEL_TEXT).toBe('取消')
    expect(PIN_SHEET_ACTIONS).toEqual([{ name: '添加到桌面' }])
  })
})

describe('formatPinDescription', () => {
  it('拼图标与名称，无工具为空', () => {
    expect(formatPinDescription({ id: 'a', name: '尺子' }, () => '📏')).toBe('📏 尺子')
    expect(formatPinDescription(null, () => '📏')).toBe('')
  })
})

describe('源码守卫', () => {
  const grid = views['/src/views/ToolGrid.vue']
  const view = views['/src/views/ToolView.vue']
  it('ToolGrid 与 ToolView 共用 PinToolSheet，ToolGrid 不再内联固定逻辑', () => {
    expect(grid).toContain('<pin-tool-sheet')
    expect(view).toContain('<pin-tool-sheet')
    expect(grid).toContain('@/shared/PinToolSheet.vue')
    expect(view).toContain('@/shared/PinToolSheet.vue')
    expect(grid).not.toContain('pinToolShortcut')
    expect(grid).not.toContain('van-action-sheet')
  })
  it('ToolView 用 van-share-sheet，并处理刷新、复制链接、设置、收藏', () => {
    const view = views['/src/views/ToolView.vue']
    expect(view).toContain('<van-share-sheet')
    expect(view).not.toContain('<van-action-sheet')
    for (const k of ['MENU_KEY_REFRESH', 'MENU_KEY_COPY_LINK', 'MENU_KEY_SETTINGS', 'MENU_KEY_STAR', 'buildToolDeepLink', 'refreshApp()']) {
      expect(view).toContain(k)
    }
  })
})
