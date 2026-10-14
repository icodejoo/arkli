import { onScopeDispose, watch } from 'vue'
import { Popup } from 'vant'

/** 挂在 window 上给原生调用的函数名 */
const BRIDGE_NAME = '__arkliBack'

/** 已打开的浮层关闭回调，后进先出 */
const stack: Array<() => void> = []

/**
 * 登记一个浮层的关闭回调，返回注销函数。
 *
 * @param close 返回键触发时的关闭动作
 * @returns 注销函数，浮层自行关闭时调用
 */
export function pushBack(close: () => void): () => void {
  stack.push(close)
  return () => {
    const i = stack.lastIndexOf(close)
    if (i >= 0) stack.splice(i, 1)
  }
}

/**
 * 处理一次返回：有浮层就关最上面那个。
 *
 * @returns 是否已被浮层消费（true 时不要再后退路由）
 */
export function handleBack(): boolean {
  const close = stack.pop()
  if (!close) return false
  close()
  return true
}

/** 把 handleBack 暴露给原生（Kotlin 返回键先问页面） */
export function installBackBridge(): void {
  ;(window as unknown as Record<string, unknown>)[BRIDGE_NAME] = handleBack
}

/** Popup 的 setup 签名（vant 未导出类型，这里只取用到的部分） */
type PopupSetup = (props: { show?: boolean }, ctx: { emit: (e: 'update:show', v: boolean) => void }) => unknown

/**
 * 全局接管 vant 浮层的返回键：包装 Popup 的 setup，显示时入栈、关闭或卸载时出栈。
 * Dialog、ImagePreview、ActionSheet、Picker 弹层都建在 Popup 之上，所以一处覆盖全部，
 * 页面里不用再逐个登记。返回键触发的是 update:show=false，与点遮罩关闭走同一条路。
 * 只需在应用启动时调用一次。
 */
export function patchVantPopup(): void {
  const comp = Popup as unknown as { setup: PopupSetup }
  const orig = comp.setup
  comp.setup = (props, ctx) => {
    /** 当前登记的注销函数 */
    let off: (() => void) | null = null
    watch(
      () => props.show,
      (v) => {
        off?.()
        off = v ? pushBack(() => ctx.emit('update:show', false)) : null
      },
      { immediate: true },
    )
    onScopeDispose(() => off?.())
    return orig(props, ctx)
  }
}
