import { onActivated, onDeactivated, ref, watch, type Ref } from 'vue'
import { useFloatStore } from '@/stores/float'
import { useToolsStore } from '@/stores/tools'

/** 同一个 ToolView 里最多同时保活几个“非浮窗”工具（取色器跳颜色助手再返回仍保留状态） */
export const KEEP_ALIVE_MAX = 3

/** 保活列表计算的入参 */
export interface LiveOptions {
  /** 当前在前台的工具 id；ToolView 不在路由里（已停用）为 null */
  current: string | null
  /** 浮窗工具 id */
  floatId: string | null
  /** 非前台保活数量上限 */
  max: number
  /** 刚被替换或关闭的旧浮窗 id，要从保活列表里剔除（它正在前台则保留） */
  dropped?: string | null
}

/**
 * 计算该留着哪些工具实例：前台 + 浮窗必留；其余历史按先后保留到上限；ToolView 停用时只留浮窗。
 *
 * @param prev 现有保活列表（按先后）
 * @param o 选项
 * @returns 新的保活列表（不在其中的实例会被卸载）
 * @example
 * reconcileLive(['a'], { current: null, floatId: 'a', max: 3 }) // ['a']
 */
export function reconcileLive(prev: readonly string[], o: LiveOptions): string[] {
  let list = prev.filter((x) => x !== o.dropped || x === o.current)
  if (!o.current) return o.floatId && list.includes(o.floatId) ? [o.floatId] : []
  if (!list.includes(o.current)) list = [...list, o.current]
  while (list.length > o.max) {
    const i = list.findIndex((x) => x !== o.current && x !== o.floatId)
    if (i < 0) break
    list.splice(i, 1)
  }
  return list
}

/** 工具页离开转场完成的计数：App 在离开动画结束后递增，ToolView 据此再卸载不需要保活的实例（避免动画中途内容消失） */
export const toolLeftTick = ref(0)

/** 通知“工具页已离开转场结束”（App.vue 调用） */
export function notifyToolPageLeft(): void {
  toolLeftTick.value++
}

/**
 * ToolView 的实例保活状态机：维护 live 列表，并在进入工具页时取回同 id 的浮窗。
 * 必须在被外层 keep-alive 缓存的 ToolView 的 setup 里调用。
 *
 * @param id 当前路由的工具 id 的 getter
 * @returns live 保活列表
 */
export function useLiveTools(id: () => string): Ref<string[]> {
  const float = useFloatStore()
  const tools = useToolsStore()
  const live = ref<string[]>([])
  /** 前台工具；停用后为 null */
  let current: string | null = null

  const floatId = (): string | null => float.floating?.id ?? null
  const reconcile = (dropped?: string | null): void => {
    live.value = reconcileLive(live.value, { current, floatId: floatId(), max: KEEP_ALIVE_MAX, dropped })
  }
  /** 进入前台：登记，访问浮窗工具本身就是取回浮窗 */
  const enter = (): void => {
    current = id()
    if (float.floating?.id === current) float.restore()
    reconcile()
  }

  watch(id, () => {
    if (current !== null) enter()
  })
  watch(
    () => float.floating?.id ?? null,
    (_n, old) => reconcile(old),
  )
  watch(toolLeftTick, () => {
    if (current === null) reconcile()
  })
  onActivated(() => {
    enter()
    tools.markUsed(id())
  })
  onDeactivated(() => {
    current = null
  })
  // 首次挂载：先登记，onActivated 随后再走一遍是幂等的
  enter()
  return live
}
