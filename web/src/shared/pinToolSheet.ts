/**
 * 固定工具快捷方式面板及胶囊底部分享面板相关纯函数与常量。
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
/** 刷新应用的动作文案 */
export const REFRESH_ACTION_LABEL = '刷新应用'
/** 分享下载链接的动作文案 */
export const SHARE_LINK_ACTION_LABEL = '分享链接'
/** 分享安装包的动作文案 */
export const SHARE_APK_ACTION_LABEL = '分享安装包'
/** 收藏动作文案 */
export const STAR_ACTION_LABEL = '收藏'
/** 取消收藏动作文案 */
export const UNSTAR_ACTION_LABEL = '取消收藏'
/** 复制链接动作文案 */
export const COPY_LINK_ACTION_LABEL = '复制链接'
/** 设置动作文案 */
export const SETTINGS_ACTION_LABEL = '设置'
/** 浮窗动作文案 */
export const FLOAT_ACTION_LABEL = '浮窗'
/** 工具忙碌时点浮窗的提示 */
export const TOAST_FLOAT_BUSY = '任务进行中，暂时不能浮窗'
/** 链接已复制的提示 */
export const TOAST_LINK_COPIED = '链接已复制'
/** 复制失败的提示 */
export const TOAST_COPY_FAILED = '复制失败'

/** 菜单项 key：分享下载链接 */
export const MENU_KEY_LINK = 'link'
/** 菜单项 key：分享安装包 */
export const MENU_KEY_APK = 'apk'
/** 菜单项 key：收藏与取消收藏 */
export const MENU_KEY_STAR = 'star'
/** 菜单项 key：添加到桌面 */
export const MENU_KEY_PIN = 'pin'
/** 菜单项 key：刷新应用 */
export const MENU_KEY_REFRESH = 'refresh'
/** 菜单项 key：复制链接 */
export const MENU_KEY_COPY_LINK = 'copyLink'
/** 菜单项 key：浮窗 */
export const MENU_KEY_FLOAT = 'float'
/** 菜单项 key：设置 */
export const MENU_KEY_SETTINGS = 'settings'

/** 设置页路由路径 */
export const SETTINGS_ROUTE = '/settings'

/** 图标名（Lucide，文件在 assets/icons，渲染见 shareSheetIcons.ts）：分享下载链接 */
export const ICON_SHARE = 'share-2'
/** 图标名：分享安装包 */
export const ICON_PACKAGE = 'package'
/** 图标名：收藏（当前未收藏） */
export const ICON_STAR = 'star'
/** 图标名：取消收藏（当前已收藏） */
export const ICON_STAR_OFF = 'star-off'
/** 图标名：添加到桌面（手机屏幕） */
export const ICON_SMARTPHONE = 'smartphone'
/** 图标名：刷新应用 */
export const ICON_REFRESH = 'refresh-cw'
/** 图标名：复制链接（链条） */
export const ICON_LINK = 'link'
/** 图标名：浮窗（画中画） */
export const ICON_FLOAT = 'picture-in-picture-2'
/** 图标名：设置 */
export const ICON_SETTINGS = 'settings'

/** 工具深链基址 */
export const DEEP_LINK_BASE = 'https://icodejoo.github.io/arkli'
/** 工具深链路径前缀（原生 App Links 接收侧沿用同一格式） */
export const DEEP_LINK_PATH_PREFIX = '/t/'
/** 工具 id 规则：小写字母数字与连字符，与注册表一致 */
export const TOOL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 固定面板选项（只有一项，ActionSheet 要求数组） */
export const PIN_SHEET_ACTIONS = [{ name: PIN_ACTION_LABEL }]

/** 胶囊菜单项（即 van-share-sheet 的 option，key 会原样透传给 select 事件） */
export interface MenuActionItem {
  /** 展示名称 */
  name: string
  /** 动作标识 */
  key: string
  /** 图标名（vant 内置图标） */
  icon: string
}

/** 要固定到桌面的工具 */
export interface PinToolTarget {
  /** 工具 id */
  id: string
  /** 工具名称 */
  name: string
}

/**
 * 构造工具页胶囊「…」底部分享面板选项（二维：第一行分享、收藏、添加到桌面、浮窗；第二行刷新、复制链接、设置；外层按 5 个一行再切片）。
 *
 * @param native 是否有原生宿主（无宿主时第一行没有“添加到桌面”）
 * @param starred 当前工具是否已收藏（决定收藏项的文案与图标）
 * @returns 两行菜单项
 * @example
 * buildMenuActions(true, false)[0].at(-1) // { name: '添加到桌面', key: 'pin', icon: 'smartphone' }
 */
export function buildMenuActions(native: boolean, starred: boolean): MenuActionItem[][] {
  const first: MenuActionItem[] = [
    { name: SHARE_LINK_ACTION_LABEL, key: MENU_KEY_LINK, icon: ICON_SHARE },
    { name: SHARE_APK_ACTION_LABEL, key: MENU_KEY_APK, icon: ICON_PACKAGE },
    { name: starred ? UNSTAR_ACTION_LABEL : STAR_ACTION_LABEL, key: MENU_KEY_STAR, icon: starred ? ICON_STAR_OFF : ICON_STAR },
  ]
  if (native) first.push({ name: PIN_ACTION_LABEL, key: MENU_KEY_PIN, icon: ICON_SMARTPHONE })
  first.push({ name: FLOAT_ACTION_LABEL, key: MENU_KEY_FLOAT, icon: ICON_FLOAT })
  const second: MenuActionItem[] = [
    { name: REFRESH_ACTION_LABEL, key: MENU_KEY_REFRESH, icon: ICON_REFRESH },
    { name: COPY_LINK_ACTION_LABEL, key: MENU_KEY_COPY_LINK, icon: ICON_LINK },
    { name: SETTINGS_ACTION_LABEL, key: MENU_KEY_SETTINGS, icon: ICON_SETTINGS },
  ]
  return [first, second]
}

/**
 * 已有浮窗时，替换确认弹窗的正文。
 *
 * @param name 现有浮窗的工具名
 * @returns 文案
 * @example
 * floatReplaceMessage('番茄钟') // '已有浮窗「番茄钟」，浮起新的会关闭它'
 */
export function floatReplaceMessage(name: string): string {
  return `已有浮窗「${name}」，浮起新的会关闭它`
}

/**
 * 拼出某工具的深链接。
 *
 * @param id 工具 id（小写字母数字与连字符）
 * @returns 形如 https://icodejoo.github.io/arkli/t/ruler 的链接
 * @throws id 不合法时抛 Error('非法工具 id')
 * @example
 * buildToolDeepLink('color-picker') // 'https://icodejoo.github.io/arkli/t/color-picker'
 */
export function buildToolDeepLink(id: string): string {
  if (!TOOL_ID_PATTERN.test(id)) throw new Error('非法工具 id')
  return `${DEEP_LINK_BASE}${DEEP_LINK_PATH_PREFIX}${id}`
}

/**
 * 刷新整个应用页面（重新加载 WebView；hash 路由下刷新后仍停在当前工具页）。
 *
 * @param reload 页面重新加载函数，默认调用 window.location.reload
 * @example
 * refreshApp()
 */
export function refreshApp(reload: () => void = () => window.location.reload()): void {
  reload()
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
