/**
 * 网页转应用封装：把一个网址固定为桌面快捷方式。
 * 对应原生 `native.shortcut.pin`，契约见 docs/design/bridge-protocol.md「网页转应用」。
 *
 * 无宿主时抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall } from './bridge'
import { requireNative, type CallFn } from './system'

/** 方法名常量 */
export const SHORTCUT_METHODS = {
  pin: 'native.shortcut.pin',
} as const

/** 固定快捷方式参数 */
export interface PinShortcutOptions {
  /** 快捷方式标识（1~64 字符），同 id 会更新 */
  id: string
  /** 桌面显示名，1~24 字 */
  label: string
  /** 网址，只允许 http / https */
  url: string
}

/** 固定快捷方式结果 */
export interface PinShortcutResult {
  /** 系统确认弹窗是否已发出；用户最终是否点了「添加」拿不到 */
  requested: boolean
  /** 没发出的原因，`unsupported` 表示桌面不支持固定快捷方式 */
  reason?: 'unsupported'
}

/**
 * 请求把网址固定到桌面。系统会弹窗让用户确认。
 *
 * @param options 快捷方式内容
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 请求结果
 * @example await pinShortcut({ id: 'zhihu', label: '知乎', url: 'https://www.zhihu.com' })
 */
export async function pinShortcut(options: PinShortcutOptions, call: CallFn = bridgeCall): Promise<PinShortcutResult> {
  requireNative(SHORTCUT_METHODS.pin)
  return call<PinShortcutResult>(SHORTCUT_METHODS.pin, { id: options.id, label: options.label, url: options.url })
}
