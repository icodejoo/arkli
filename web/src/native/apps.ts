/**
 * 应用管理封装：列表、打开、应用详情（卸载入口）、导出安装包、应用图标。
 * 对应原生 `native.apps.*`，契约见 docs/design/bridge-protocol.md「应用管理方法」。
 *
 * 原生没有申请「查询全部应用」权限，只能列出可启动应用。无宿主时全部抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall } from './bridge'
import { requireNative, type CallFn } from './system'

/** 方法名常量 */
export const APPS_METHODS = {
  list: 'native.apps.list',
  open: 'native.apps.open',
  settings: 'native.apps.settings',
  exportApk: 'native.apps.exportApk',
  icon: 'native.apps.icon',
} as const

/** 缓存产物的同源 URL 前缀 */
const FILES_URL_PREFIX = '/files/'

/** 一个已安装应用 */
export interface AppInfo {
  /** 包名 */
  pkg: string
  /** 应用名 */
  label: string
  /** 版本名 */
  versionName: string
  /** 版本号 */
  versionCode: number
  /** 首次安装时间（毫秒时间戳） */
  firstInstallMs: number
  /** 最近更新时间（毫秒时间戳） */
  lastUpdateMs: number
  /** 是否系统应用 */
  isSystem: boolean
  /** base APK 大小（字节），取不到为 0 */
  apkBytes: number
}

/** 导出安装包的结果 */
export interface ExportedApk {
  /** 缓存相对路径，可交给 `share` */
  path: string
  /** 文件名 */
  name: string
  /** 字节数 */
  bytes: number
}

/**
 * 列出可启动应用，按应用名排序。
 *
 * @param includeSystem 是否包含系统应用，默认 false
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 应用列表
 * @example const apps = await listApps()
 */
export async function listApps(includeSystem = false, call: CallFn = bridgeCall): Promise<AppInfo[]> {
  requireNative(APPS_METHODS.list)
  const r = await call<{ items: AppInfo[] }>(APPS_METHODS.list, { includeSystem })
  return r.items
}

/**
 * 启动应用。
 *
 * @param pkg 包名
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 是否成功拉起
 * @example await openApp('com.tencent.mm')
 */
export async function openApp(pkg: string, call: CallFn = bridgeCall): Promise<boolean> {
  requireNative(APPS_METHODS.open)
  const r = await call<{ opened: boolean }>(APPS_METHODS.open, { pkg })
  return r.opened === true
}

/**
 * 打开系统的应用详情页（用户可在那里卸载，本封装不直接卸载）。
 *
 * @param pkg 包名
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 是否成功拉起
 * @example await openAppSettings('com.tencent.mm')
 */
export async function openAppSettings(pkg: string, call: CallFn = bridgeCall): Promise<boolean> {
  requireNative(APPS_METHODS.settings)
  const r = await call<{ opened: boolean }>(APPS_METHODS.settings, { pkg })
  return r.opened === true
}

/**
 * 导出应用安装包（base APK，≤300MB）到缓存，之后可 `share`。
 * 拷贝大文件可能较久，所以不设超时，可用 signal 取消。
 *
 * @param pkg 包名
 * @param signal 取消信号，可选
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 产物路径、文件名与大小
 * @example const { path } = await exportApk('com.tencent.mm')
 */
export async function exportApk(pkg: string, signal?: AbortSignal, call: CallFn = bridgeCall): Promise<ExportedApk> {
  requireNative(APPS_METHODS.exportApk)
  const options = { timeoutMs: 0, signal } as { timeoutMs?: number }
  return call<ExportedApk>(APPS_METHODS.exportApk, { pkg }, options)
}

/**
 * 取应用图标：原生渲染成 PNG 放进缓存，返回缓存相对路径。
 *
 * @param pkg 包名
 * @param size 边长（像素，48~192），缺省 96
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 缓存相对路径，用 {@link appFileUrl} 转成可显示的 URL
 * @example img.src = appFileUrl(await appIcon('com.tencent.mm'))
 */
export async function appIcon(pkg: string, size?: number, call: CallFn = bridgeCall): Promise<string> {
  requireNative(APPS_METHODS.icon)
  const params: Record<string, unknown> = { pkg }
  if (size !== undefined) params.size = size
  const r = await call<{ path: string }>(APPS_METHODS.icon, params)
  return r.path
}

/**
 * 缓存相对路径转同源 URL，可直接给 `<img src>`。
 *
 * @param path 形如 `cache/out/app-icons/a.png`
 * @returns `/files/<path>`
 * @example appFileUrl('cache/out/a.png') // '/files/cache/out/a.png'
 */
export function appFileUrl(path: string): string {
  return FILES_URL_PREFIX + path
}
