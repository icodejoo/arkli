// 动画偏好：尊重系统“减少动态效果”

/**
 * 系统是否开启了“减少动态效果”。
 *
 * @returns 开启时为 true，此时页面应直接出结果、不播动画
 * @example
 * const wait = prefersReducedMotion() ? 0 : 900
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}
