/**
 * 主题同步封装：把页面选的主题模式告诉原生，原生记住并据此设置状态栏图标与原生页面深浅。
 * 对应原生 `native.theme.set`，契约见 docs/design/bridge-protocol.md「native.theme.set」。
 *
 * 无宿主（桌面浏览器调试）时静默跳过。
 */
import { call as bridgeCall, isNativeAvailable } from './bridge'
import type { CallFn } from './system'

/** 方法名常量 */
export const THEME_METHODS = {
  set: 'native.theme.set',
} as const

/**
 * 通知原生当前主题模式；无宿主或原生不支持（旧包）时静默忽略，不抛错。
 *
 * @param mode 主题模式：`light` / `dark` / `system`
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @example await setNativeTheme('dark')
 */
export async function setNativeTheme(mode: string, call: CallFn = bridgeCall): Promise<void> {
  if (!isNativeAvailable()) return
  try {
    await call(THEME_METHODS.set, { mode })
  } catch {
    // 原生没有这个方法或调用失败：页面主题不受影响，只是原生栏位不同步
  }
}
