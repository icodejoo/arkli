import { onActivated, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** 译文区最小高度（px），屏幕太矮时兜底 */
export const OUT_MIN_HEIGHT = 120

/**
 * 计算译文区高度：页面高度 - 它自己的 pageY - 它下方在文档流里的实际占用。
 * 下方占用 = 卡片内边距 + 操作栏占位 + 页面底部内边距等，实测得到，不写死，所以刚好一屏、不出页面滚动条。
 *
 * @param pageHeight 页面（视口）高度
 * @param pageY 译文区顶部相对页面的纵坐标
 * @param below 译文区下方在文档流里占的高度
 * @returns 高度（px），不小于 OUT_MIN_HEIGHT
 * @example calcOutHeight(800, 300, 74) // 426
 */
export function calcOutHeight(pageHeight: number, pageY: number, below: number): number {
  return Math.max(OUT_MIN_HEIGHT, Math.floor(pageHeight - pageY - below))
}

/**
 * 量元素下方在文档流里实际占的高度：沿祖先链逐层累加“该层最后一个流内子元素底边 - 当前节点底边 + 该层下内边距与边框”。
 * 不用 scrollHeight（内容不满一屏时它会被撑到视口高度，量出来偏大）；fixed / absolute 子元素不算流内。
 *
 * @param el 目标元素
 * @returns 下方占用（px）
 */
export function flowBelow(el: HTMLElement): number {
  let below = 0
  let node: HTMLElement = el
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p)
    const kids = Array.from(p.children).filter((c) => {
      const pos = getComputedStyle(c).position
      return pos !== 'fixed' && pos !== 'absolute'
    })
    const last = kids[kids.length - 1] ?? node
    below += Math.max(0, last.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom)
    below += parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth)
    node = p
  }
  return below
}

/**
 * 让某个元素的高度撑满“它下方到页面底部”的剩余一屏空间；窗口或页面布局变化时自动重算。
 *
 * @param el 目标元素
 * @returns 高度（px）的响应式引用，绑到 style.height 即可
 * @example const h = useOutHeight(outEl) // <div ref="outEl" :style="{ height: h + 'px' }">
 */
export function useOutHeight(el: Ref<HTMLElement | null>): Ref<number> {
  const height = ref(OUT_MIN_HEIGHT)
  let observer: ResizeObserver | null = null

  /** 量一次：量不到元素就保持原值 */
  function measure(): void {
    if (!el.value) return
    const pageY = el.value.getBoundingClientRect().top + window.scrollY
    const below = flowBelow(el.value)
    height.value = calcOutHeight(window.innerHeight, pageY, below)
  }

  onMounted(() => {
    measure()
    window.addEventListener('resize', measure)
    if (typeof ResizeObserver !== 'undefined') {
      // 上方内容（图片列表、提示条）增减会把译文区顶下去，监听 body 尺寸变化重算
      observer = new ResizeObserver(measure)
      observer.observe(document.body)
    }
  })
  onActivated(measure)
  onBeforeUnmount(() => {
    window.removeEventListener('resize', measure)
    observer?.disconnect()
  })
  return height
}
