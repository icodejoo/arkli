/**
 * 固定工具快捷方式面板及胶囊菜单相关纯函数与常量。
 */

/** 添加到桌面的动作文案 */
export const PIN_ACTION_LABEL = '添加到桌面'
/** 弹窗取消按钮文案 */
export const PIN_CANCEL_TEXT = '取消'
/** 系统弹窗已发出时的提示 */
export const PIN_REQUESTED_TOAST = '请在系统弹窗里确认添加'
/** 桌面不支持快捷方式时的提示 */
export const PIN_UNSUPPORTED_TOAST = '当前桌面不支持添加快捷方式'
/** 固定失败的默认提示 */
export const PIN_FAILED_TOAST = '添加失败'
/** 菜单项 key：添加到桌面 */
export const MENU_KEY_PIN = 'pin'
/** 固定面板选项（只有一项，ActionSheet 要求数组） */
export const PIN_SHEET_ACTIONS = [{ name: PIN_ACTION_LABEL }]

/** 胶囊菜单项 */
export interface MenuActionItem {
  /** 展示名称 */
  name: string
  /** 动作标识 */
  key: string
}

/** 要固定到桌面的工具 */
export interface PinToolTarget {
  /** 工具 id */
  id: string
  /** 工具名称 */
  name: string
}

/**
 * 构造工具页胶囊「…」菜单项；有原生宿主时在两项分享之后追加“添加到桌面”。
 *
 * @param native 是否有原生宿主
 * @returns 菜单项列表
 * @example
 * buildMenuActions(true).at(-1) // { name: '添加到桌面', key: 'pin' }
 */
export function buildMenuActions(native: boolean): MenuActionItem[] {
  const actions: MenuActionItem[] = [
    { name: '分享下载链接', key: 'link' },
    { name: '分享安装包', key: 'apk' },
  ]
  if (native) actions.push({ name: PIN_ACTION_LABEL, key: MENU_KEY_PIN })
  return actions
}

/**
 * 固定请求结果转 toast 文案。
 *
 * @param r 原生返回结果
 * @returns 提示文案
 * @example
 * pinResultToast({ requested: true }) // '请在系统弹窗里确认添加'
 */
export function pinResultToast(r: { requested: boolean }): string {
  return r.requested ? PIN_REQUESTED_TOAST : PIN_UNSUPPORTED_TOAST
}

/**
 * 固定异常转 toast 文案：Error 用其 message，否则用默认文案。
 *
 * @param e 捕获的异常
 * @returns 提示文案
 * @example
 * pinErrorToast(null) // '添加失败'
 */
export function pinErrorToast(e: unknown): string {
  return e instanceof Error ? e.message : PIN_FAILED_TOAST
}

/**
 * 固定面板顶部描述：图标 + 名称，无工具时为空串。
 *
 * @param tool 目标工具
 * @param getIcon 取工具图标的函数
 * @returns 描述文案
 * @example
 * formatPinDescription({ id: 'a', name: '尺子' }, () => '📏') // '📏 尺子'
 */
export function formatPinDescription(tool: PinToolTarget | null | undefined, getIcon: (id: string) => string): string {
  return tool ? `${getIcon(tool.id)} ${tool.name}` : ''
}
