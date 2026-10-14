/**
 * 系统能力封装：剪贴板、分享、系统设置、外部跳转、震动、屏幕、设备信息、权限。
 * 对应原生 `native.clipboard.*` / `share` / `settings.open` / `intent.*` / `haptic.vibrate` / `screen.*` / `device.*` / `permission.*`，
 * 契约见 docs/design/bridge-protocol.md「系统能力方法」。
 *
 * 没有宿主（桌面浏览器调试）时：clipboard / share / vibrate 退回浏览器 API；
 * 设备类方法返回 null；其余抛 {@link NativeUnavailableError}。每个函数的 JSDoc 写明了具体降级。
 */
import { call as bridgeCall, isNativeAvailable } from './bridge'
import { copyText } from '@/shared/clipboard'

/** 原生调用函数形状，便于注入测试 */
export type CallFn = <T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<T>

/** 不在 Arkli 容器内、又没有浏览器兜底时抛出的错误 */
export class NativeUnavailableError extends Error {
  /** 想用的方法名 */
  readonly method: string

  /**
   * @param method 想调用的原生方法名
   */
  constructor(method: string) {
    super(`当前不在 Arkli 容器内，无法使用 ${method}`)
    this.name = 'NativeUnavailableError'
    this.method = method
  }
}

/** 方法名常量 */
export const SYSTEM_METHODS = {
  clipboardWrite: 'native.clipboard.write',
  clipboardRead: 'native.clipboard.read',
  share: 'native.share',
  settingsOpen: 'native.settings.open',
  intentOpen: 'native.intent.open',
  processText: 'native.intent.processText',
  vibrate: 'native.haptic.vibrate',
  keepAwake: 'native.screen.keepAwake',
  brightness: 'native.screen.brightness',
  immersive: 'native.screen.immersive',
  deviceInfo: 'native.device.info',
  deviceStatus: 'native.device.status',
  deviceDisplay: 'native.device.display',
  permissionCheck: 'native.permission.check',
  permissionRequest: 'native.permission.request',
} as const

/** 可打开的系统设置页 */
export type SettingsPage =
  | 'wifi'
  | 'display'
  | 'battery'
  | 'developer'
  | 'app'
  | 'notification'
  | 'date'
  | 'locale'
  | 'accessibility'
  | 'bluetooth'
  | 'storage'

/** 外部跳转种类 */
export type IntentKind = 'url' | 'dial' | 'sms' | 'mail' | 'map' | 'market'

/** 可查询 / 申请的权限名 */
export type PermissionName = 'camera' | 'microphone' | 'notifications' | 'media_images'

/** 分享参数 */
export interface ShareOptions {
  /** 要分享的文本 */
  text?: string
  /** 缓存相对路径（如 `cache/out/a.png`），只有 `cache/out/` 下的文件可分享 */
  path?: string
  /** 内容类型；缺省按扩展名猜，纯文本为 text/plain */
  mime?: string
  /** 分享面板标题 */
  title?: string
}

/** 权限查询 / 申请结果 */
export interface PermissionResult {
  /** 是否已授予 */
  granted: boolean
  /** 未授予的原因；`not_declared` 表示 App 清单没声明这个权限 */
  reason?: 'not_declared'
}

/** 传感器条目 */
export interface SensorItem {
  /** 传感器名称 */
  name: string
  /** `Sensor.TYPE_*` 数值 */
  type: number
  /** 类型字符串，如 `android.sensor.accelerometer`，取不到为 null */
  typeName: string | null
}

/** 屏幕参数 */
export interface DeviceDisplay {
  /** 真实宽（像素） */
  widthPx: number | null
  /** 真实高（像素） */
  heightPx: number | null
  /** 横向每英寸像素 */
  xdpi: number | null
  /** 纵向每英寸像素 */
  ydpi: number | null
  /** 密度桶 dpi */
  densityDpi: number | null
  /** 逻辑密度 */
  density: number | null
  /** 刷新率（Hz），取不到为 null */
  refreshRate: number | null
}

/** 设备静态信息，取不到的字段为 null */
export interface DeviceInfo {
  /** 品牌 */
  brand: string | null
  /** 型号 */
  model: string | null
  /** 设备代号 */
  device: string | null
  /** 制造商 */
  manufacturer: string | null
  /** Android 版本号，如 `14` */
  androidVersion: string | null
  /** API 级别 */
  sdkInt: number | null
  /** 安全补丁日期 */
  securityPatch: string | null
  /** 支持的 ABI */
  abis: string[]
  /** 是否鸿蒙系统 */
  harmonyOs: boolean | null
  /** 系统品牌（鸿蒙为 `harmony`），非鸿蒙为 null */
  osBrand: string | null
  /** 总内存（字节） */
  totalMemBytes: number | null
  /** 屏幕参数 */
  display: DeviceDisplay
  /** 传感器列表 */
  sensors: SensorItem[] | null
  /** 语言标签，如 `zh-CN` */
  locale: string | null
  /** 时区 id，如 `Asia/Shanghai` */
  timeZone: string | null
  /** 系统特性开关：键如 nfc / bluetoothLe / fingerprint / gyroscope，值为是否支持，取不到为 null */
  features: Record<string, boolean | null>
}

/** 设备动态状态，取不到的字段为 null */
export interface DeviceStatus {
  /** 电量百分比 0~100 */
  batteryPercent: number | null
  /** 是否正在充电（含已充满且接着电源） */
  charging: boolean | null
  /** 充电状态：charging / discharging / not_charging / full / unknown */
  chargeStatus: string
  /** 充电状态中文 */
  chargeStatusText: string
  /** 供电方式：ac / usb / wireless / dock / none */
  plugType: string
  /** 供电方式中文 */
  plugText: string
  /** 电池温度（摄氏度） */
  batteryTempC: number | null
  /** 电池电压（毫伏） */
  batteryVoltageMv: number | null
  /** 可用内存（字节） */
  availMemBytes: number | null
  /** 系统是否处于低内存状态 */
  lowMemory: boolean | null
  /** 内部存储总量（字节） */
  storageTotalBytes: number | null
  /** 内部存储可用（字节） */
  storageFreeBytes: number | null
  /** 网络类型：wifi / cellular / ethernet / bluetooth / vpn / other / none，取不到为 null */
  networkType: string | null
  /** 网络类型中文 */
  networkText: string | null
  /** 是否省电模式 */
  powerSave: boolean | null
}

/** 没有宿主时抛错 */
export function requireNative(method: string): void {
  if (!isNativeAvailable()) throw new NativeUnavailableError(method)
}

/**
 * 写剪贴板。
 *
 * 无宿主时退回 `@/shared/clipboard` 的 `copyText`（此时忽略 `sensitive`）。
 *
 * @param text 要写入的文本
 * @param sensitive 是否标记为敏感内容（系统剪贴板预览会隐藏），默认 false
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 是否写入成功；原生失败会 reject
 * @example await clipboardWrite('验证码 123456', true)
 */
export async function clipboardWrite(text: string, sensitive = false, call: CallFn = bridgeCall): Promise<boolean> {
  if (!isNativeAvailable()) return copyText(text)
  const r = await call<{ written: boolean }>(SYSTEM_METHODS.clipboardWrite, { text, sensitive })
  return r.written === true
}

/**
 * 读剪贴板。
 *
 * 无宿主时尝试 `navigator.clipboard.readText()`，拿不到（无权限、不支持）返回 null。
 * 原生侧 Android 10+ 只有应用在前台时能读，拿不到同样是 null，不抛错。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 文本；拿不到为 null
 * @example const t = await clipboardRead()
 */
export async function clipboardRead(call: CallFn = bridgeCall): Promise<string | null> {
  if (!isNativeAvailable()) {
    try {
      return (await navigator.clipboard?.readText?.()) ?? null
    } catch {
      return null
    }
  }
  const r = await call<{ text: string | null }>(SYSTEM_METHODS.clipboardRead, {})
  return r.text ?? null
}

/**
 * 调起系统分享面板。
 *
 * 无宿主时退回 `navigator.share`（只带 text 与 title，忽略 path / mime）；浏览器不支持、只给了 path、或用户取消都返回 false。
 *
 * @param options 分享内容，text 与 path 至少一个
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 是否成功拉起分享面板
 * @example await share({ path: 'cache/out/a.png', title: '分享图片' })
 */
export async function share(options: ShareOptions, call: CallFn = bridgeCall): Promise<boolean> {
  if (!isNativeAvailable()) {
    if (!options.text || typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false
    try {
      await navigator.share({ text: options.text, title: options.title })
      return true
    } catch {
      return false
    }
  }
  const r = await call<{ started: boolean }>(SYSTEM_METHODS.share, { ...options })
  return r.started === true
}

/**
 * 打开系统设置页。无宿主时抛 {@link NativeUnavailableError}。
 *
 * @param page 页面名，见 {@link SettingsPage}
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 是否成功拉起（false 表示系统里没有这个页面）
 * @example await openSettings('battery')
 */
export async function openSettings(page: SettingsPage, call: CallFn = bridgeCall): Promise<boolean> {
  requireNative(SYSTEM_METHODS.settingsOpen)
  const r = await call<{ opened: boolean }>(SYSTEM_METHODS.settingsOpen, { page })
  return r.opened === true
}

/**
 * 打开外部链接 / 拨号 / 短信 / 邮件 / 地图 / 应用市场。无宿主时抛 {@link NativeUnavailableError}。
 *
 * @param kind 种类，见 {@link IntentKind}
 * @param value 目标。url 必须带 http(s)://；其余可只写主体（电话号码、邮箱、`纬度,经度`、包名）
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 是否成功拉起（false 表示没有能处理的应用）
 * @example await openIntent('dial', '10086')
 */
export async function openIntent(kind: IntentKind, value: string, call: CallFn = bridgeCall): Promise<boolean> {
  requireNative(SYSTEM_METHODS.intentOpen)
  const r = await call<{ opened: boolean }>(SYSTEM_METHODS.intentOpen, { kind, value })
  return r.opened === true
}

/**
 * 把文本交给已安装的翻译等「处理文本」应用。无宿主时返回 false。
 *
 * @param text 要处理的文本
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 是否有应用接手
 * @example if (!(await processText('hello'))) tip('没有可用的翻译应用')
 */
export async function processText(text: string, call: CallFn = bridgeCall): Promise<boolean> {
  if (!isNativeAvailable()) return false
  const r = await call<{ handled: boolean }>(SYSTEM_METHODS.processText, { text })
  return r.handled === true
}

/**
 * 震动。
 *
 * 无宿主时退回 `navigator.vibrate`（自动换成浏览器的 `[震, 停…]` 顺序），不支持返回 false。
 *
 * @param pattern 毫秒数组 `[停, 震, 停, 震…]`；传单个数字表示震这么久
 * @param repeat 循环起点下标，缺省不循环
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 是否真的震了（设备没有马达为 false）
 * @example await vibrate([0, 80, 40, 80])
 */
export async function vibrate(pattern: number | number[], repeat?: number, call: CallFn = bridgeCall): Promise<boolean> {
  const arr = typeof pattern === 'number' ? [0, pattern] : pattern
  if (!isNativeAvailable()) {
    // 浏览器序列是 [震, 停, ...]，与本函数的 [停, 震, ...] 错开一位：首项为 0 直接去掉，否则前面补一个 0 的震动
    const navPattern = arr[0] === 0 ? arr.slice(1) : [0, ...arr]
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' ? navigator.vibrate(navPattern) : false
  }
  const params: Record<string, unknown> = { pattern: arr }
  if (repeat !== undefined) params.repeat = repeat
  const r = await call<{ vibrated: boolean }>(SYSTEM_METHODS.vibrate, params)
  return r.vibrated === true
}

/**
 * 取消正在进行的震动。无宿主时退回 `navigator.vibrate(0)`。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @example await cancelVibrate()
 */
export async function cancelVibrate(call: CallFn = bridgeCall): Promise<void> {
  if (!isNativeAvailable()) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(0)
    return
  }
  await call(SYSTEM_METHODS.vibrate, { cancel: true })
}

/**
 * 屏幕常亮开关（只影响本应用窗口）。无宿主时抛 {@link NativeUnavailableError}，浏览器里请用 `@/shared/wakelock`。
 *
 * @param on 是否常亮
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @example await keepAwake(true)
 */
export async function keepAwake(on: boolean, call: CallFn = bridgeCall): Promise<void> {
  requireNative(SYSTEM_METHODS.keepAwake)
  await call(SYSTEM_METHODS.keepAwake, { on })
}

/**
 * 设置窗口亮度（只影响本应用窗口）。无宿主时抛 {@link NativeUnavailableError}。
 *
 * @param value 0~1；传 -1 跟随系统
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @example await setBrightness(1)
 */
export async function setBrightness(value: number, call: CallFn = bridgeCall): Promise<void> {
  requireNative(SYSTEM_METHODS.brightness)
  await call(SYSTEM_METHODS.brightness, { value })
}

/**
 * 沉浸模式：隐藏 / 恢复状态栏与导航栏。无宿主时抛 {@link NativeUnavailableError}。
 *
 * @param on 是否沉浸
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @example await setImmersive(true)
 */
export async function setImmersive(on: boolean, call: CallFn = bridgeCall): Promise<void> {
  requireNative(SYSTEM_METHODS.immersive)
  await call(SYSTEM_METHODS.immersive, { on })
}

/**
 * 设备静态信息。无宿主时返回 null。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 设备信息；无宿主为 null
 * @example const info = await deviceInfo()
 */
export async function deviceInfo(call: CallFn = bridgeCall): Promise<DeviceInfo | null> {
  if (!isNativeAvailable()) return null
  return call<DeviceInfo>(SYSTEM_METHODS.deviceInfo, {})
}

/**
 * 设备动态状态（电量、内存、存储、网络等）。无宿主时返回 null。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 状态；无宿主为 null
 * @example const s = await deviceStatus()
 */
export async function deviceStatus(call: CallFn = bridgeCall): Promise<DeviceStatus | null> {
  if (!isNativeAvailable()) return null
  return call<DeviceStatus>(SYSTEM_METHODS.deviceStatus, {})
}

/**
 * 屏幕参数。无宿主时返回 null。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 屏幕参数；无宿主为 null
 * @example const d = await deviceDisplay()
 */
export async function deviceDisplay(call: CallFn = bridgeCall): Promise<DeviceDisplay | null> {
  if (!isNativeAvailable()) return null
  return call<DeviceDisplay>(SYSTEM_METHODS.deviceDisplay, {})
}

/**
 * 查询权限是否已授予，不弹窗。无宿主时抛 {@link NativeUnavailableError}。
 *
 * @param name 权限名，见 {@link PermissionName}
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns `{ granted, reason? }`，清单没声明时 `reason` 为 `not_declared`
 * @example if (!(await checkPermission('camera')).granted) await requestPermission('camera')
 */
export async function checkPermission(name: PermissionName, call: CallFn = bridgeCall): Promise<PermissionResult> {
  requireNative(SYSTEM_METHODS.permissionCheck)
  return call<PermissionResult>(SYSTEM_METHODS.permissionCheck, { name })
}

/**
 * 申请权限（未授予时弹系统对话框）。无宿主时抛 {@link NativeUnavailableError}。
 *
 * @param name 权限名，见 {@link PermissionName}
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns `{ granted, reason? }`，清单没声明时 `reason` 为 `not_declared`
 * @example const { granted } = await requestPermission('notifications')
 */
export async function requestPermission(name: PermissionName, call: CallFn = bridgeCall): Promise<PermissionResult> {
  requireNative(SYSTEM_METHODS.permissionRequest)
  return call<PermissionResult>(SYSTEM_METHODS.permissionRequest, { name })
}
