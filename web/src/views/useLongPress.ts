/**
 * 长按识别：按住超过 delay 毫秒且手指没明显移动，就触发回调；
 * 触发后紧随的那次 click 要被吞掉，避免长按同时又进了页面。
 */

/** 长按判定时长（毫秒） */
export const LONG_PRESS_MS = 500
/** 手指移动超过这个距离（像素）就算滑动，取消长按 */
export const LONG_PRESS_MOVE_PX = 10

/** 长按控制器 */
export interface LongPress {
  /** 手指按下：开始计时 */
  start(e: TouchEvent, key: string): void
  /** 手指移动：位移过大则取消 */
  move(e: TouchEvent): void
  /** 手指抬起或取消：停止计时 */
  end(): void
  /** 若刚刚触发过长按则返回 true 并复位，调用方据此吞掉 click */
  consumeClick(): boolean
}

/**
 * 创建长按控制器。
 *
 * @param onLongPress 长按触发回调，参数为 start 时传入的 key
 * @param delay 判定时长，默认 {@link LONG_PRESS_MS}
 * @returns 控制器，把四个方法挂到元素的 touchstart/touchmove/touchend/click 上
 * @example const lp = createLongPress((id) => openSheet(id))
 */
export function createLongPress(onLongPress: (key: string) => void, delay = LONG_PRESS_MS): LongPress {
  /** 计时器句柄 */
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 按下时的坐标 */
  let origin = { x: 0, y: 0 }
  /** 是否刚触发过长按（等着吞 click） */
  let fired = false

  /** 清掉计时器 */
  function clear(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  return {
    start(e, key) {
      clear()
      fired = false
      const t = e.touches[0]
      origin = { x: t?.clientX ?? 0, y: t?.clientY ?? 0 }
      timer = setTimeout(() => {
        timer = null
        fired = true
        onLongPress(key)
      }, delay)
    },
    move(e) {
      const t = e.touches[0]
      if (!t || timer === null) return
      if (Math.hypot(t.clientX - origin.x, t.clientY - origin.y) > LONG_PRESS_MOVE_PX) clear()
    },
    end: clear,
    consumeClick() {
      const was = fired
      fired = false
      return was
    },
  }
}
