// 水平仪：重力向量 -> 俯仰/横滚换算、低通滤波、校准、条形折算（纯逻辑，与 Vue 解耦）
//
// 坐标约定（Android Chrome 的 accelerationIncludingGravity，手机平放屏幕朝上时 z ≈ +9.8）：
// x 向屏幕右，y 向屏幕上沿，z 垂直屏幕向外。读数是「支撑力」方向，与重力相反。
// iOS 的符号相反，调用方可传 invert 取反。

/** 弧度转角度系数 */
const RAD_TO_DEG = 180 / Math.PI
/** 标准重力加速度（m/s²），用来判断读数是否可信 */
export const GRAVITY = 9.80665
/** 低通滤波默认系数：越小越稳但越迟钝 */
export const DEFAULT_ALPHA = 0.15
/** 读数模长偏离重力超过这个比例时，认为在晃动，不可信 */
export const SHAKE_TOLERANCE = 0.35
/** 条形模式折算的步长：手机每转 90 度，水平线换一条边 */
export const QUARTER_TURN = 90
/** 圆形气泡满量程角度（度），超出贴边 */
export const BUBBLE_FULL_SCALE = 15

/** 三轴向量 */
export interface Vec3 {
  /** 屏幕右向分量 */
  x: number
  /** 屏幕上沿分量 */
  y: number
  /** 屏幕外向分量 */
  z: number
}

/** 俯仰/横滚（度） */
export interface Tilt {
  /** 俯仰：顶边抬起为正 */
  pitch: number
  /** 横滚：右边抬起为正 */
  roll: number
}

/**
 * 重力读数换算为俯仰/横滚。
 *
 * @param v 三轴读数（Android 约定）
 * @param invert 为 true 时整体取反（iOS 符号相反）
 * @returns 俯仰、横滚（度）；向量为零时返回 0/0
 * @example
 * tiltFromGravity({ x: 0, y: 0, z: 9.8 }) // { pitch: 0, roll: 0 }
 */
export function tiltFromGravity(v: Vec3, invert = false): Tilt {
  const s = invert ? -1 : 1
  const x = v.x * s
  const y = v.y * s
  const z = v.z * s
  if (x === 0 && y === 0 && z === 0) return { pitch: 0, roll: 0 }
  return {
    pitch: Math.atan2(y, Math.hypot(x, z)) * RAD_TO_DEG,
    roll: Math.atan2(x, Math.hypot(y, z)) * RAD_TO_DEG,
  }
}

/**
 * 手机离「平放」的总倾斜角。
 *
 * @param v 三轴读数
 * @returns 0（平放，正反面都算）到 90（竖直）度；向量为零返回 0
 * @example
 * totalTilt({ x: 0, y: 9.8, z: 0 }) // 90
 */
export function totalTilt(v: Vec3): number {
  const m = Math.hypot(v.x, v.y, v.z)
  if (m === 0) return 0
  return Math.acos(Math.min(1, Math.abs(v.z) / m)) * RAD_TO_DEG
}

/**
 * 手机立起来时，屏幕平面内相对竖直方向的转角（用于靠墙/靠边测水平）。
 *
 * @param v 三轴读数
 * @returns 度数，竖直握持为 0，向右转为正，范围 (-180, 180]
 * @example
 * inPlaneAngle({ x: 0, y: 9.8, z: 0 }) // 0
 */
export function inPlaneAngle(v: Vec3): number {
  return Math.atan2(v.x, v.y) * RAD_TO_DEG
}

/**
 * 把平面内转角折算成相对最近一条水平/竖直边的偏差，条形模式用。
 *
 * @param deg 任意角度
 * @returns 落在 [-45, 45] 的偏差
 * @example
 * foldToQuarter(93) // 3
 */
export function foldToQuarter(deg: number): number {
  const r = ((deg % QUARTER_TURN) + QUARTER_TURN) % QUARTER_TURN
  return r > QUARTER_TURN / 2 ? r - QUARTER_TURN : r
}

/**
 * 向量一阶低通滤波。
 *
 * @param prev 上一次滤波结果，没有则直接返回 next
 * @param next 新读数
 * @param alpha 新值权重 (0,1]，越大越跟手；非法值回退默认
 * @returns 滤波后的向量
 * @example
 * lowPass({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0.5) // { x: 5, y: 0, z: 0 }
 */
export function lowPass(prev: Vec3 | null, next: Vec3, alpha = DEFAULT_ALPHA): Vec3 {
  if (!prev) return { ...next }
  const a = alpha > 0 && alpha <= 1 ? alpha : DEFAULT_ALPHA
  return {
    x: prev.x + a * (next.x - prev.x),
    y: prev.y + a * (next.y - prev.y),
    z: prev.z + a * (next.z - prev.z),
  }
}

/**
 * 读数模长是否接近重力（不接近说明在晃动，角度不可信）。
 *
 * @param v 三轴读数
 * @returns 可信返回 true
 * @example
 * isSteady({ x: 0, y: 0, z: 9.8 }) // true
 */
export function isSteady(v: Vec3): boolean {
  const m = Math.hypot(v.x, v.y, v.z)
  return Math.abs(m - GRAVITY) <= GRAVITY * SHAKE_TOLERANCE
}

/**
 * 读数是否是有限数值（防 null / NaN）。
 *
 * @param v 可能不完整的读数
 * @returns 三个分量都是有限数时为 true
 * @example
 * isValidVec({ x: 1, y: null, z: 2 }) // false
 */
export function isValidVec(v: { x?: number | null; y?: number | null; z?: number | null } | null | undefined): v is Vec3 {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

/**
 * 减去校准零点。
 *
 * @param t 当前角度
 * @param zero 校准时记录的角度，没有则不改
 * @returns 校准后的角度
 * @example
 * applyZero({ pitch: 5, roll: 2 }, { pitch: 3, roll: 1 }) // { pitch: 2, roll: 1 }
 */
export function applyZero(t: Tilt, zero: Tilt | null): Tilt {
  if (!zero) return { ...t }
  return { pitch: t.pitch - zero.pitch, roll: t.roll - zero.roll }
}

/**
 * 角度映射为气泡位置（-1~1，超出贴边）。
 *
 * @param deg 角度
 * @param fullScale 满量程角度，非正数时按默认
 * @returns 归一化位置
 * @example
 * bubbleOffset(7.5, 15) // 0.5
 */
export function bubbleOffset(deg: number, fullScale = BUBBLE_FULL_SCALE): number {
  const f = fullScale > 0 ? fullScale : BUBBLE_FULL_SCALE
  return Math.max(-1, Math.min(1, deg / f))
}

/**
 * 角度读数格式化（保留 1 位，避免出现 -0.0）。
 *
 * @param deg 角度
 * @returns 如 "3.2°"
 * @example
 * formatDeg(-0.04) // "0.0°"
 */
export function formatDeg(deg: number): string {
  const r = Math.round(deg * 10) / 10
  return `${(r === 0 ? 0 : r).toFixed(1)}°`
}

/** 运动事件名 */
export const EVENT_MOTION = 'devicemotion'
/** 超过这么久（毫秒）没收到有效读数，就认为设备不支持 */
export const NO_DATA_TIMEOUT_MS = 2500

/** 事件源最小接口（window 或测试用的假对象） */
export interface MotionSourceLike {
  /** 添加监听 */
  addEventListener(type: string, listener: (e: never) => void): void
  /** 移除监听 */
  removeEventListener(type: string, listener: (e: never) => void): void
}

/** 传感器状态 */
export type MotionStatus = 'waiting' | 'ok' | 'unsupported'

/** 订阅选项 */
export interface GravityOptions {
  /** 事件源，一般是 window */
  target: MotionSourceLike
  /** 滤波后的读数回调 */
  onVector: (v: Vec3) => void
  /** 状态变化回调 */
  onStatus: (s: MotionStatus) => void
  /** 滤波系数，默认 DEFAULT_ALPHA */
  alpha?: number
  /** 无数据超时（毫秒），默认 NO_DATA_TIMEOUT_MS */
  timeoutMs?: number
}

/**
 * 订阅 devicemotion 的含重力加速度，低通后回调；读不到数据时超时报 unsupported。
 *
 * @param opt 订阅选项
 * @returns 停止函数，卸载时必须调用（会清监听与定时器）
 * @example
 * const stop = startGravity({ target: window, onVector: (v) => {}, onStatus: () => {} })
 * stop()
 */
export function startGravity(opt: GravityOptions): () => void {
  let last: Vec3 | null = null
  let stopped = false
  opt.onStatus('waiting')
  const timer = setTimeout(() => {
    if (!stopped && !last) opt.onStatus('unsupported')
  }, opt.timeoutMs ?? NO_DATA_TIMEOUT_MS)
  const handler = (e: { accelerationIncludingGravity?: { x?: number | null; y?: number | null; z?: number | null } | null }): void => {
    const a = e.accelerationIncludingGravity
    if (stopped || !isValidVec(a)) return
    const first = !last
    last = lowPass(last, a, opt.alpha)
    if (first) opt.onStatus('ok')
    opt.onVector(last)
  }
  opt.target.addEventListener(EVENT_MOTION, handler as (e: never) => void)
  return () => {
    stopped = true
    clearTimeout(timer)
    opt.target.removeEventListener(EVENT_MOTION, handler as (e: never) => void)
  }
}
