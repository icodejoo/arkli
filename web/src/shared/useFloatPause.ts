import { inject, onActivated, onBeforeUnmount, onDeactivated, watch, type InjectionKey } from 'vue'
import { useFloatStore } from '@/stores/float'

/** ToolView 给每个工具实例提供的“工具 id”注入键（BottomActions 与 useFloatBusy 靠它知道自己属于谁） */
export const FLOAT_TOOL_ID: InjectionKey<string> = Symbol('arkli-float-tool-id')

/** 暂停 / 恢复回调 */
export interface FloatPauseHooks {
  /** 工具离开前台（被浮起或跳去别处）时调用：停计时器、音频、传感器、相机 */
  pause: () => void
  /** 工具回到前台时调用：恢复 pause 里停掉的东西 */
  resume: () => void
}

/**
 * 工具被浮起（或离开前台）时暂停、回来时恢复。内部用 onDeactivated / onActivated，
 * 保证 pause 与 resume 严格交替：重复的停用不会重复 pause，首次挂载的激活不会触发 resume。
 * 仍要在 onBeforeUnmount 里做最终清理（被销毁时不会 resume）。
 *
 * @param hooks 暂停与恢复回调
 * @example
 * useFloatPause({ pause: () => ctx.suspend(), resume: () => ctx.resume() })
 */
export function useFloatPause(hooks: FloatPauseHooks): void {
  let paused = false
  onDeactivated(() => {
    if (paused) return
    paused = true
    hooks.pause()
  })
  onActivated(() => {
    if (!paused) return
    paused = false
    hooks.resume()
  })
}

/**
 * 汇报“有不可暂停的任务”（AI 生成、下载、拍摄等）：忙碌时该工具不能被浮起。
 * 不在 ToolView 里（无工具 id）时什么也不做；组件卸载时自动撤销汇报。
 * 使用 BottomActions 的 mainLoading 的页面已自动汇报，无需再调用。
 *
 * @param busy 返回是否忙碌的 getter（响应式）
 * @example
 * useFloatBusy(() => recording.value)
 */
export function useFloatBusy(busy: () => boolean): void {
  const id = inject(FLOAT_TOOL_ID, null)
  if (!id) return
  const store = useFloatStore()
  /** 本来源已汇报的状态，避免重复计数 */
  let last = false
  /** 同步状态到 store */
  const sync = (v: boolean): void => {
    if (v === last) return
    last = v
    store.reportBusy(id, v)
  }
  watch(busy, (v) => sync(!!v), { immediate: true })
  onBeforeUnmount(() => sync(false))
}
