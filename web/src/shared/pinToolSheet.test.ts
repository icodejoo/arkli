import { describe, expect, it } from 'vitest'
import {
  PIN_ACTION_LABEL,
  PIN_CANCEL_TEXT,
  PIN_FAILED_TOAST,
  PIN_REQUESTED_TOAST,
  PIN_SHEET_ACTIONS,
  PIN_UNSUPPORTED_TOAST,
  buildMenuActions,
  formatPinDescription,
  pinErrorToast,
  pinResultToast,
} from './pinToolSheet'

/** 视图源码原文，供守卫测试扫描 */
const views = import.meta.glob('/src/views/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('buildMenuActions', () => {
  it('无宿主只有两项分享', () => {
    expect(buildMenuActions(false).map((a) => a.key)).toEqual(['link', 'apk'])
  })
  it('有宿主在分享之后追加添加到桌面', () => {
    const a = buildMenuActions(true)
    expect(a.map((x) => x.key)).toEqual(['link', 'apk', 'pin'])
    expect(a[2].name).toBe(PIN_ACTION_LABEL)
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
})
