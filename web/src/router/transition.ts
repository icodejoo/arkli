/**
 * 页面转场的方向判断：iOS 风格，进入更深一层是推入（push），回到更浅一层是弹出（pop）。
 *
 * 只看路由层级，不依赖 history API，所以 `router.replace('/')` 这类“没有历史就回首页”的兜底也能判成后退。
 */

/** 转场种类：推入（前进）或弹出（后退） */
export type PageTransition = 'push' | 'pop'

/**
 * 路由层级深度：首页为 0，其余页面（工具页、设置页）为 1。
 *
 * @param path 路由路径，如 `/`、`/tool/ruler`
 * @returns 层级深度
 * @example routeDepth('/tool/ruler') // 1
 */
export function routeDepth(path: string): number {
  return path === '' || path === '/' ? 0 : 1
}

/**
 * 从一个路由切到另一个路由时用哪种转场。
 *
 * @param toPath 目标路由路径
 * @param fromPath 来源路由路径
 * @returns 目标更浅（回首页）为 `pop`，其余（含同层切换）为 `push`
 * @example pageTransition('/', '/tool/ruler') // 'pop'
 */
export function pageTransition(toPath: string, fromPath: string): PageTransition {
  return routeDepth(toPath) < routeDepth(fromPath) ? 'pop' : 'push'
}

/** 页面名（路由 name）里需要 keep-alive 缓存并记住滚动位置的那些：目前只有首页 */
export const CACHED_ROUTES: ReadonlySet<string> = new Set(['home'])

/**
 * 判断某个路由是否被 keep-alive 缓存。
 *
 * @param name 路由 name，可能为空
 * @returns 被缓存返回 true
 */
export function isCachedRoute(name: unknown): boolean {
  return typeof name === 'string' && CACHED_ROUTES.has(name)
}

/**
 * 转场期间页面脱离文档流（position: fixed），会丢掉窗口的滚动位置。
 * 用内联样式让它停在应有的位置：`top: -scrollY`，并把滚动量放进 `--hold-scroll`，
 * 供页面里固定定位的元素（导航栏、状态栏遮罩）往回补偿。
 * 离开的页面用它保持原样；回到被缓存的页面时用它还原到上次离开时的位置。
 *
 * @param el 页面根元素
 * @param scrollY 要保持的滚动量（像素），不大于 0 时什么都不做
 */
export function holdScroll(el: HTMLElement, scrollY: number): void {
  if (scrollY <= 0) return
  el.style.top = `${-scrollY}px`
  el.style.setProperty('--hold-scroll', `${scrollY}px`)
}

/**
 * 撤销 {@link holdScroll} 写的内联样式。被 keep-alive 缓存的页面是同一个 DOM 节点，转场结束后必须清掉，
 * 否则下次再进来会残留旧的 top。
 *
 * @param el 页面根元素
 */
export function releaseScroll(el: HTMLElement): void {
  el.style.top = ''
  el.style.removeProperty('--hold-scroll')
}
