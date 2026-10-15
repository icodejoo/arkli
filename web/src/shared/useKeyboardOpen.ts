import { onBeforeUnmount, onMounted, readonly, ref, type Ref } from 'vue'

/** 原生推来的输入法状态事件名，与 Kotlin 的 SafeInsets.KB_EVENT 对应 */
export const KB_EVENT = 'arkli-keyboard'
/** 输入法弹出时原生加在 `<html>` 上的类名，与 Kotlin 的 SafeInsets.KB_CLASS 对应 */
export const KB_CLASS = 'kb-open'

/**
 * 跟踪软键盘是否弹出，完全由原生事件驱动：键盘开始弹出即为 true，完全收起才为 false。
 * 原生 imePadding 会把 WebView 缩小，fixed 底栏会被顶到键盘上方，用它在键盘弹出时隐藏底栏。
 * 没有宿主（浏览器里调试）时永远为 false。
 *
 * @returns 只读的 `open` 状态
 * @example
 * const open = useKeyboardOpen()
 * // <van-tabbar v-if="!open" />
 */
export function useKeyboardOpen(): Readonly<Ref<boolean>> {
  const open = ref(false)

  /** 收到原生事件：按 detail.open 更新 */
  function onEvent(e: Event): void {
    open.value = !!(e as CustomEvent<{ open?: boolean }>).detail?.open
  }

  onMounted(() => {
    // 页面加载时键盘可能已经开着，读一次类名兜底
    open.value = document.documentElement.classList.contains(KB_CLASS)
    window.addEventListener(KB_EVENT, onEvent)
  })
  onBeforeUnmount(() => window.removeEventListener(KB_EVENT, onEvent))
  return readonly(open)
}
