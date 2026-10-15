// 全屏展示类工具的「原生横屏 + 沉浸」控制：进入时切横屏并隐藏系统栏，离开时还原，无宿主时什么都不做
import { setImmersive, setOrientation } from '@/native/system'

/** 横屏控制器 */
export interface Landscape {
  /** 切到横屏并隐藏系统栏；无宿主或不支持时静默忽略 */
  enter: () => Promise<void>
  /** 还原竖屏与系统栏；没进过横屏则什么都不做，可重复调用 */
  leave: () => Promise<void>
}

/** 横屏控制器依赖的原生调用，便于单测注入 */
export interface LandscapeDeps {
  /** 设置屏幕方向 */
  orientation: typeof setOrientation
  /** 设置沉浸模式 */
  immersive: typeof setImmersive
}

/**
 * 创建横屏控制器：每个页面各建一个，页面卸载时务必调用 `leave`。
 *
 * @param deps 原生调用，默认走 bridge（仅测试注入）
 * @returns 控制器
 * @example
 * const land = createLandscape()
 * await land.enter()          // 进入全屏展示
 * onUnmounted(() => void land.leave())
 */
export function createLandscape(deps: LandscapeDeps = { orientation: setOrientation, immersive: setImmersive }): Landscape {
  /** 是否已切到横屏（离开时据此还原） */
  let on = false
  return {
    async enter() {
      try {
        await deps.orientation('landscape')
        on = true
        await deps.immersive(true)
      } catch {
        // 无宿主或不支持，保持页面内全屏
      }
    },
    async leave() {
      if (!on) return
      on = false
      try {
        await deps.immersive(false)
        await deps.orientation('portrait')
      } catch {
        // 忽略
      }
    },
  }
}
