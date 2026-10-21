import { describe, expect, it, vi } from 'vitest'
import { resolveActionIcon } from './bottomActionIcons'
import { BOTTOM_ACTION_DEFAULTS, BOTTOM_ACTION_KEYS, BOTTOM_ACTION_REGISTRY, MORE_ICON, normalizeActions, splitCollapsed } from './bottomActions'

/** 取 key 列表 */
const keys = (xs: readonly { key: string }[]): string[] => xs.map((x) => x.key)

describe('BOTTOM_ACTION_REGISTRY', () => {
  it('key 唯一，每项都有文案；非主按钮都有图标', () => {
    expect(new Set(BOTTOM_ACTION_KEYS).size).toBe(BOTTOM_ACTION_KEYS.length)
    for (const d of BOTTOM_ACTION_REGISTRY) {
      expect(d.text).toBeTruthy()
      if (d.key !== 'main') expect('icon' in d && d.icon).toBeTruthy()
    }
  })
  it('每个内置图标都有组件映射（防漏），页面传 vant 图标名则不映射', () => {
    for (const d of BOTTOM_ACTION_REGISTRY) if ('icon' in d) expect(resolveActionIcon(d.icon), d.key).toBeTruthy()
    expect(resolveActionIcon(MORE_ICON)).toBeTruthy()
    expect(resolveActionIcon('star-o')).toBeUndefined()
  })
  it('顺序稳定：ai 在首、main 在末，选图 → 编辑 → 输出 → 查看', () => {
    const k = [...BOTTOM_ACTION_KEYS]
    expect(k[0]).toBe('ai')
    expect(k[k.length - 1]).toBe('main')
    expect(k.indexOf('album')).toBeLessThan(k.indexOf('photo'))
    expect(k.indexOf('photo')).toBeLessThan(k.indexOf('undo'))
    expect(k.indexOf('undo')).toBeLessThan(k.indexOf('copy'))
    expect(k.indexOf('copy')).toBeLessThan(k.indexOf('preview'))
  })
  it('delete 是 danger；旧 DEFAULTS 兼容', () => {
    expect(BOTTOM_ACTION_REGISTRY.find((d) => d.key === 'delete')).toMatchObject({ tone: 'danger' })
    expect(BOTTOM_ACTION_DEFAULTS.album).toEqual({ text: '相册', icon: 'arkli:images' })
    expect(BOTTOM_ACTION_DEFAULTS.photo.icon).toBe('arkli:camera')
    expect(BOTTOM_ACTION_DEFAULTS.main).toEqual({ text: '生成' })
  })
})

describe('normalizeActions', () => {
  it('数组写法：按注册表顺序而非书写顺序', () => {
    expect(keys(normalizeActions(['share', 'copy', 'album']))).toEqual(['album', 'copy', 'share'])
  })
  it('对象写法：false 不启用，覆盖 text / disabled / color', () => {
    const r = normalizeActions({ save: true, copy: false, delete: { disabled: true, text: '删除所选', color: '#f00' } })
    expect(keys(r)).toEqual(['save', 'delete'])
    expect(r[1]).toMatchObject({ text: '删除所选', disabled: true, color: '#f00', tone: 'danger', loading: false })
    expect(r[0]).toMatchObject({ text: '保存', disabled: false, tone: 'default', loading: false })
  })
  it('旧别名并入：布尔开关、mainText / mainColor / iconColor / disabled', () => {
    const r = normalizeActions(['copy'], {
      flags: { album: true, main: true, photo: false },
      mainText: '翻译',
      mainColor: '#111',
      iconColor: '#222',
      disabled: { main: true, album: true },
    })
    expect(keys(r)).toEqual(['album', 'copy', 'main'])
    expect(r.find((i) => i.key === 'main')).toMatchObject({ text: '翻译', color: '#111', disabled: true, loading: false })
    expect(r.find((i) => i.key === 'album')).toMatchObject({ color: '#222', disabled: true, loading: false })
  })
  it('loading 归一化：mainLoading 别名、actions.main.loading、非 main 项恒为 false', () => {
    // 1. mainLoading 别名生效
    const withAlias = normalizeActions(['main'], { mainLoading: true })
    expect(withAlias.find((i) => i.key === 'main')?.loading).toBe(true)

    // 2. actions.main.loading 生效，且优先于 legacy
    const withActions = normalizeActions({ main: { loading: true } })
    expect(withActions.find((i) => i.key === 'main')?.loading).toBe(true)

    const withBoth = normalizeActions({ main: { loading: false } }, { mainLoading: true })
    expect(withBoth.find((i) => i.key === 'main')?.loading).toBe(false)

    // 3. 默认未指定时为 false
    const withoutLoading = normalizeActions(['main'])
    expect(withoutLoading.find((i) => i.key === 'main')?.loading).toBe(false)

    // 4. 非 main 项 loading 恒为 false（即使配置中传了 loading）
    const iconsWithLoading = normalizeActions(
      { copy: { loading: true } as never, album: true },
      { mainLoading: true },
    )
    expect(iconsWithLoading.find((i) => i.key === 'copy')?.loading).toBe(false)
    expect(iconsWithLoading.find((i) => i.key === 'album')?.loading).toBe(false)
  })
  it('未知 key 告警并忽略', () => {
    const warn = vi.fn()
    expect(keys(normalizeActions(['copy', 'nope'] as never, {}, warn))).toEqual(['copy'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('nope')
  })
  it('重做有独立图标（不再镜像撤销）', () => {
    expect(normalizeActions(['redo'])[0]).toMatchObject({ icon: 'arkli:redo-2' })
  })
})

describe('splitCollapsed', () => {
  const mk = (...ks: string[]) => normalizeActions(ks as never)
  it('刚好 maxVisible 不收纳', () => {
    const r = splitCollapsed(mk('copy', 'save', 'share', 'print'), 4)
    expect(r.more).toEqual([])
    expect(r.visible).toHaveLength(4)
  })
  it('超出时前 max-1 项显示，其余进更多', () => {
    const r = splitCollapsed(mk('copy', 'save', 'share', 'print', 'delete'), 4)
    expect(keys(r.visible)).toEqual(['copy', 'save', 'share'])
    expect(keys(r.more)).toEqual(['print', 'delete'])
  })
  it('0 / Infinity 关闭收纳', () => {
    const items = mk('copy', 'save', 'share', 'print', 'delete', 'edit')
    expect(splitCollapsed(items, 0).more).toEqual([])
    expect(splitCollapsed(items, Infinity).more).toEqual([])
  })
  it('ai / main 不参与收纳也不计数', () => {
    const r = splitCollapsed(mk('ai', 'copy', 'save', 'share', 'main'), 3)
    expect(keys(r.visible)).toEqual(['copy', 'save', 'share'])
    expect(r.more).toEqual([])
  })
})
