// 屏幕常亮：封装 navigator.wakeLock（旧 WebView 多半没有），页面重新可见时自动重新申请

/** 屏幕唤醒锁的最小结构 */
interface SentinelLike {
  release(): Promise<void>
}

/** navigator 上与唤醒锁相关的最小结构（测试可注入） */
export interface WakeNavigator {
  wakeLock?: { request(type: 'screen'): Promise<SentinelLike> }
}

/** 页面可见性事件源的最小结构 */
export interface VisibilityDoc {
  visibilityState: string
  addEventListener(type: 'visibilitychange', fn: () => void): void
  removeEventListener(type: 'visibilitychange', fn: () => void): void
}

/** 常亮控制器 */
export interface WakeLockHandle {
  /** 当前环境是否支持 wakeLock */
  supported: boolean
  /** 申请常亮；返回是否成功（不支持或被拒为 false，不抛错） */
  acquire(): Promise<boolean>
  /** 释放常亮并停止自动重新申请 */
  release(): Promise<void>
}

/**
 * 创建常亮控制器。
 *
 * @param nav navigator，缺省取全局
 * @param doc document，缺省取全局
 * @returns 控制器；不支持时 supported 为 false，acquire 直接返回 false
 * @example
 * const wl = createWakeLock()
 * if (!(await wl.acquire())) showToast('请在系统设置里调长息屏时间')
 */
export function createWakeLock(nav: WakeNavigator | undefined = typeof navigator === 'undefined' ? undefined : navigator, doc: VisibilityDoc | undefined = typeof document === 'undefined' ? undefined : document): WakeLockHandle {
  const api = nav?.wakeLock
  let want = false
  let sentinel: SentinelLike | undefined

  /** 静默释放一个 sentinel，已被系统释放时会抛错，忽略 */
  const drop = async (s: SentinelLike | undefined): Promise<void> => {
    try {
      await s?.release()
    } catch {
      // 已被系统释放时忽略
    }
  }
  /** 实际向系统申请一次；await 期间若已 release，拿到的锁立即释放，不留悬空 */
  const request = async (): Promise<boolean> => {
    if (!api) return false
    try {
      const next = await api.request('screen')
      if (!want) {
        await drop(next)
        return false
      }
      // 连续申请时旧的 sentinel 会被覆盖，先释放，否则没人能再释放它
      const old = sentinel
      sentinel = next
      if (old && old !== next) await drop(old)
      return true
    } catch {
      return false
    }
  }
  /** 页面切回前台时，系统已自动释放了锁，需要重新申请 */
  const onVisible = (): void => {
    if (want && doc?.visibilityState === 'visible') void request()
  }

  return {
    supported: !!api,
    async acquire() {
      want = true
      doc?.addEventListener('visibilitychange', onVisible)
      return request()
    },
    async release() {
      want = false
      doc?.removeEventListener('visibilitychange', onVisible)
      const s = sentinel
      sentinel = undefined
      await drop(s)
    },
  }
}
