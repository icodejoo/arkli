// 指南针：方位角换算、圆周平滑、传感器事件订阅（与 Vue 解耦，事件源可注入）

/** 圆周度数 */
export const FULL_CIRCLE = 360
/** 8 个方位名，从正北顺时针 */
export const DIRECTIONS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'] as const
/** 平滑系数：越小越稳但越迟钝 */
export const DEFAULT_SMOOTH = 0.2
/** 绝对方向事件名 */
export const EVENT_ABSOLUTE = 'deviceorientationabsolute'
/** 普通方向事件名 */
export const EVENT_RELATIVE = 'deviceorientation'
/** 超过这么久（毫秒）还没收到有效数据，就认为设备不支持 */
export const NO_DATA_TIMEOUT_MS = 2500

/** 方向事件里指南针要用的字段 */
export interface OrientationLike {
  /** 绕 z 轴旋转角，0~360 */
  alpha?: number | null
  /** 是否相对地球坐标系（磁北） */
  absolute?: boolean
  /** iOS 专有：相对磁北的航向 */
  webkitCompassHeading?: number
}

/** 事件源最小接口（window 或测试用的假对象） */
export interface EventSourceLike {
  addEventListener(type: string, listener: (e: never) => void): void
  removeEventListener(type: string, listener: (e: never) => void): void
}

/** 传感器状态 */
export type CompassStatus = 'idle' | 'waiting' | 'ok' | 'unsupported'

/**
 * 角度归一到 [0, 360)。
 *
 * @param deg 任意角度
 * @returns 0 到 360（不含）之间的等价角度
 * @example
 * normalizeDeg(-10) // 350
 */
export function normalizeDeg(deg: number): number {
  const r = deg % FULL_CIRCLE
  return r < 0 ? r + FULL_CIRCLE : r
}

/**
 * 两个角度的最短带符号差（to - from），结果在 (-180, 180]。
 *
 * @param from 起点角度
 * @param to 终点角度
 * @returns 沿最短弧从 from 转到 to 需要的度数
 * @example
 * angleDiff(359, 1) // 2
 */
export function angleDiff(from: number, to: number): number {
  let d = normalizeDeg(to - from)
  if (d > FULL_CIRCLE / 2) d -= FULL_CIRCLE
  return d
}

/**
 * 角度转 8 方位名。
 *
 * @param deg 方位角（度，0 为正北顺时针）
 * @returns 如「东北」
 * @example
 * directionName(350) // '北'
 */
export function directionName(deg: number): string {
  const step = FULL_CIRCLE / DIRECTIONS.length
  return DIRECTIONS[Math.floor(normalizeDeg(deg + step / 2) / step) % DIRECTIONS.length]
}

/**
 * 从方向事件算出屏幕朝上方向的方位角。
 *
 * @param e 方向事件
 * @param screenAngle 屏幕旋转角（screen.orientation.angle），默认 0
 * @returns 方位角 0~360（度）；事件没有可用数据时为 null
 * @example
 * headingFromEvent({ alpha: 90, absolute: true }) // 270
 */
export function headingFromEvent(e: OrientationLike, screenAngle = 0): number | null {
  let base: number | null = null
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
    base = e.webkitCompassHeading
  } else if (typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    base = FULL_CIRCLE - e.alpha
  }
  if (base == null) return null
  return normalizeDeg(base + (Number.isFinite(screenAngle) ? screenAngle : 0))
}

/** 圆周低通平滑器 */
export interface Smoother {
  /** 送入一个新角度，返回平滑后的角度 */
  push(deg: number): number
  /** 清空历史 */
  reset(): void
}

/**
 * 创建圆周低通平滑器：沿最短弧插值，359°→1° 不会绕大圈。
 *
 * @param alpha 平滑系数 (0,1]，越小越稳；默认 0.2
 * @returns 平滑器
 * @example
 * const s = createSmoother(0.5)
 * s.push(359); s.push(1) // 约 0
 */
export function createSmoother(alpha = DEFAULT_SMOOTH): Smoother {
  const a = alpha > 0 && alpha <= 1 ? alpha : DEFAULT_SMOOTH
  let cur: number | null = null
  return {
    push(deg) {
      const d = normalizeDeg(deg)
      cur = cur == null ? d : normalizeDeg(cur + angleDiff(cur, d) * a)
      return cur
    },
    reset() {
      cur = null
    },
  }
}

/** 订阅选项 */
export interface CompassOptions {
  /** 事件源，通常是 window */
  target: EventSourceLike
  /** 读取当前屏幕旋转角 */
  getScreenAngle?: () => number
  /** 收到平滑后的方位角 */
  onHeading: (deg: number) => void
  /** 状态变化 */
  onStatus: (s: CompassStatus) => void
  /** 平滑系数 */
  smooth?: number
  /** 无数据超时（毫秒） */
  timeoutMs?: number
}

/**
 * 开始监听指南针：优先 deviceorientationabsolute，收不到再退回 deviceorientation。
 *
 * @param opts 订阅选项
 * @returns 停止函数，会解绑全部事件并清掉超时定时器
 * @example
 * const stop = startCompass({ target: window, onHeading: (d) => (deg.value = d), onStatus: (s) => (st.value = s) })
 * onUnmounted(stop)
 */
export function startCompass(opts: CompassOptions): () => void {
  const smoother = createSmoother(opts.smooth)
  let got = false
  let absoluteSeen = false
  opts.onStatus('waiting')

  /** 处理一条事件；fromAbsolute 标记来源 */
  const handle = (fromAbsolute: boolean) => (e: never) => {
    const ev = e as OrientationLike
    // 相对事件里没有磁北信息（非 iOS）时不能当指南针用
    if (!fromAbsolute && absoluteSeen) return
    if (!fromAbsolute && !ev.absolute && typeof ev.webkitCompassHeading !== 'number') return
    const h = headingFromEvent(ev, opts.getScreenAngle?.() ?? 0)
    if (h == null) return
    if (fromAbsolute) absoluteSeen = true
    if (!got) {
      got = true
      opts.onStatus('ok')
    }
    opts.onHeading(smoother.push(h))
  }
  const onAbs = handle(true)
  const onRel = handle(false)
  opts.target.addEventListener(EVENT_ABSOLUTE, onAbs)
  opts.target.addEventListener(EVENT_RELATIVE, onRel)
  const timer = setTimeout(() => {
    if (!got) opts.onStatus('unsupported')
  }, opts.timeoutMs ?? NO_DATA_TIMEOUT_MS)
  return () => {
    clearTimeout(timer)
    opts.target.removeEventListener(EVENT_ABSOLUTE, onAbs)
    opts.target.removeEventListener(EVENT_RELATIVE, onRel)
  }
}
