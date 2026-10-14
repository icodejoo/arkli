// 常亮接线：原生 keepAwake 优先，失败回退 @/shared/wakelock
import { keepAwake } from '@/native/system'
import { createWakeLock } from '@/shared/wakelock'
import { createAwake, type Awake } from './logic'

/**
 * 创建接好线的常亮控制器（原生优先，网页兜底）。
 *
 * @returns 控制器；用完记得在卸载时 release
 * @example
 * const awake = createAppAwake()
 * await awake.acquire()
 */
export function createAppAwake(): Awake {
  return createAwake({ native: keepAwake, web: createWakeLock() })
}
