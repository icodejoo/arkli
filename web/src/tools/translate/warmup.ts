// 预热状态机（纯逻辑，不依赖 Vue 与原生桥，便于单测）

/** 预热状态机依赖的两个原生调用（可注入） */
export interface WarmupDeps {
  /** 预热，支持取消 */
  warmup: (signal: AbortSignal) => Promise<unknown>
  /** 卸载 */
  unload: () => Promise<unknown>
}

/** 预热控制器 */
export interface WarmupController {
  /** 开始预热；已在预热或已完成则忽略 */
  warm: () => void
  /** 取消进行中的预热并卸载；一次进入只卸载一次，重复调用无效 */
  release: () => void
}

/**
 * 创建预热状态机。预热失败一律静默（不改外部状态），失败后允许再次 warm 重试。
 *
 * @param deps 预热与卸载的原生调用
 * @returns warm / release
 * @example const w = createWarmup({ warmup: (s) => aiWarmup('local-nllb', s), unload: () => aiUnload('local-nllb') })
 */
export function createWarmup(deps: WarmupDeps): WarmupController {
  /** 是否已进入（预热过，离开时需要卸载） */
  let entered = false
  /** 预热进行中或已成功 */
  let warm = false
  /** 当前这一轮预热的取消控制器 */
  let controller: AbortController | null = null

  return {
    warm() {
      if (warm) return
      warm = true
      entered = true
      const c = new AbortController()
      controller = c
      deps.warmup(c.signal).catch(() => {
        // 静默；仍是当前这一轮时放开重试（被取消的已由 release 重置）
        if (controller === c) {
          warm = false
          controller = null
        }
      })
    },
    release() {
      if (!entered) return
      entered = false
      warm = false
      controller?.abort()
      controller = null
      void Promise.resolve()
        .then(deps.unload)
        .catch(() => {})
    },
  }
}
