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
  /** 取消进行中的预热并卸载；一次进入只卸载一次，重复调用无效。返回的 promise 在卸载请求结束后兑现（失败也兑现） */
  release: () => Promise<void>
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
      if (!entered) return Promise.resolve()
      entered = false
      warm = false
      controller?.abort()
      controller = null
      return Promise.resolve()
        .then(deps.unload)
        .then(
          () => undefined,
          () => undefined,
        )
    },
  }
}

/** 跟随提供者的预热依赖：按提供者 id 预热与卸载（可注入） */
export interface ProviderWarmupDeps {
  /** 预热指定提供者，支持取消 */
  warmup: (provider: string, signal: AbortSignal) => Promise<unknown>
  /** 卸载指定提供者 */
  unload: (provider: string) => Promise<unknown>
}

/** 跟随提供者的预热控制器 */
export interface ProviderWarmup {
  /** 同步目标：提供者变了先释放旧的（等卸载结束），再在 ready 时预热新的；ready 为假只记下不预热 */
  sync: (provider: string | undefined, ready: boolean) => void
  /** 登记本页额外用到的提供者（如极短输入改走 Qwen）；离页 release 时一并卸载，避免会话常驻 */
  occupy: (provider: string) => void
  /** 离页：取消并卸载当前提供者，以及 occupy 登记过的其余提供者 */
  release: () => void
}

/**
 * 创建跟随提供者的预热器：同一时刻只让一个提供者的会话常驻。切换时先卸载旧的、卸完再预热新的，
 * 避免两个大模型同时占内存；离页释放当前的，回来时等卸载结束再重新预热。
 *
 * @param deps 按提供者 id 的预热与卸载
 * @returns sync / release
 * @example
 * const w = createProviderWarmup({ warmup: (id, s) => aiWarmup(id, s), unload: (id) => aiUnload(id) })
 * w.sync('local-nllb', true) // 预热 NLLB
 * w.sync('local-qwen', true) // 先卸 NLLB，卸完预热 Qwen
 */
export function createProviderWarmup(deps: ProviderWarmupDeps): ProviderWarmup {
  /** 当前跟随的提供者 */
  let current: string | undefined
  /** 当前提供者的预热状态机 */
  let ctl: WarmupController | null = null
  /** 最近一次 sync 是否要求预热 */
  let want = false
  /** 本页额外占用（用过）的提供者集合，离页时一起卸载 */
  const extras = new Set<string>()
  /** 上一次释放（卸载）的完成信号，新的预热排在它后面 */
  let pending: Promise<void> = Promise.resolve()

  /** 释放当前状态机，并把它的卸载接到等待链上（连续释放不会丢掉前一次的等待） */
  const releaseCurrent = (): void => {
    if (!ctl) return
    const done = ctl.release()
    pending = pending.then(() => done)
  }

  /** 为某个提供者造状态机 */
  const make = (id: string): WarmupController =>
    createWarmup({ warmup: (s) => deps.warmup(id, s), unload: () => deps.unload(id) })

  return {
    sync(provider, ready) {
      if (provider !== current) {
        releaseCurrent()
        current = provider
        ctl = provider === undefined ? null : make(provider)
        // 新的当前提供者由状态机自己管卸载，不必再算作额外占用
        if (provider !== undefined) extras.delete(provider)
      }
      want = ready
      const mine = ctl
      if (!mine || !ready) return
      void pending.then(() => {
        // 等待期间又切走、离页或变为未就绪，就不预热了
        if (ctl === mine && want) mine.warm()
      })
    },
    occupy(provider) {
      if (provider !== current) extras.add(provider)
    },
    release() {
      want = false
      releaseCurrent()
      // 额外占用的提供者没有预热状态机，直接卸载（失败静默），并排进等待链
      for (const id of extras) {
        const done = Promise.resolve()
          .then(() => deps.unload(id))
          .then(
            () => undefined,
            () => undefined,
          )
        pending = pending.then(() => done)
      }
      extras.clear()
    },
  }
}
