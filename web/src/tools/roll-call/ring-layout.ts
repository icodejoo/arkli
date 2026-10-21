/**
 * 随机点名 3D 滚筒：环布局、几何参数、旋转停靠与图集 UV 纯逻辑计算。
 */

/** 每环固定槽位数 */
export const SLOTS_PER_RING = 16

/** 滚筒最少环数：名单少时重复名字补满，让舞台上下不留白（取奇数，中奖环居中） */
export const MIN_RINGS = 7

/** 名字默认最大显示字数（超出截断） */
export const DEFAULT_MAX_CHARS = 6

/** 省略号字符 */
export const ELLIPSIS = '...'

/** 图集每行默认列数 */
export const ATLAS_COLUMNS = 8

/**
 * 环上的一个槽位数据
 */
export interface RingSlot {
  /** 名字文本（未截断） */
  name: string
  /** 环索引 (0 ~ ringCount - 1) */
  ringIndex: number
  /** 槽位在环内的索引 (0 ~ SLOTS_PER_RING - 1) */
  slotIndex: number
  /** 全局扁平索引 (0 ~ totalSlots - 1) */
  globalIndex: number
  /** 是否为中奖者槽位 */
  isWinner: boolean
}

/**
 * 单个环的数据
 */
export interface RingData {
  /** 环索引 (0 ~ ringCount - 1) */
  ringIndex: number
  /** 环上的所有槽位，长度固定为 SLOTS_PER_RING */
  slots: RingSlot[]
}

/**
 * 滚筒环布局输出结果
 */
export interface RingLayoutResult {
  /** 总环数 */
  ringCount: number
  /** 各环数据 */
  rings: RingData[]
  /** 中奖者所在环的索引 */
  targetRingIndex: number
  /** 中奖者在目标环中的槽位索引 */
  targetSlotIndex: number
  /** 总槽位数 (ringCount * SLOTS_PER_RING) */
  totalSlots: number
}

/**
 * 环运动参数
 */
export interface RingMotionConfig {
  /** 旋转方向：1 为顺时针，-1 为逆时针 */
  direction: 1 | -1
  /** 额外旋转整圈数 */
  extraRounds: number
  /** 停下时间占总时长的比例 (0~1) */
  stopRatio: number
}

/**
 * 长名字字号与长度自适应截断：超出指定字数加省略号。
 *
 * @param name 原始名字
 * @param maxChars 最大字符数（默认 6）
 * @returns 截断后的展示文本
 * @example truncateName('古力娜扎尔·买买提', 6) // '古力娜扎...'
 */
export function truncateName(name: string, maxChars = DEFAULT_MAX_CHARS): string {
  const trimmed = name.trim()
  if (trimmed.length <= maxChars) return trimmed
  const cutLen = Math.max(1, maxChars - 1)
  return `${trimmed.slice(0, cutLen)}${ELLIPSIS}`
}

/**
 * 根据名单与中奖者构建多环滚筒布局。
 *
 * @param names 候选名单
 * @param winner 本次抽中的名字
 * @returns 环布局与槽位分配结果
 * @example buildRingLayout(['张三', '李四'], '张三')
 */
export function buildRingLayout(names: readonly string[], winner: string): RingLayoutResult {
  const safeNames = names.length ? names.map((n) => n.trim()).filter(Boolean) : [winner || '']
  const pool = safeNames.length ? safeNames : [winner || '']
  const ringCount = Math.max(MIN_RINGS, Math.ceil(pool.length / SLOTS_PER_RING))
  const targetRingIndex = Math.floor(ringCount / 2)
  const targetSlotIndex = 0
  const totalSlots = ringCount * SLOTS_PER_RING

  const rings: RingData[] = []
  let globalIndex = 0
  let poolCursor = 0

  for (let r = 0; r < ringCount; r++) {
    const slots: RingSlot[] = []
    for (let s = 0; s < SLOTS_PER_RING; s++) {
      const isWinner = r === targetRingIndex && s === targetSlotIndex
      const slotName = isWinner ? winner : pool[poolCursor % pool.length]
      slots.push({
        name: slotName,
        ringIndex: r,
        slotIndex: s,
        globalIndex,
        isWinner,
      })
      globalIndex++
      if (!isWinner) poolCursor++
    }
    rings.push({ ringIndex: r, slots })
  }

  return {
    ringCount,
    rings,
    targetRingIndex,
    targetSlotIndex,
    totalSlots,
  }
}

/**
 * 计算图集网格行列数。
 *
 * @param totalCount 总槽位数
 * @param columns 每行列数（默认 8）
 * @returns 行列数
 * @example calcAtlasGrid(48, 8) // { columns: 8, rows: 6 }
 */
export function calcAtlasGrid(totalCount: number, columns = ATLAS_COLUMNS): { columns: number; rows: number } {
  const safeCols = Math.max(1, columns)
  const rows = Math.max(1, Math.ceil(Math.max(1, totalCount) / safeCols))
  return { columns: safeCols, rows }
}

/**
 * 计算槽位在文字图集中的 UV 坐标范围。
 *
 * @param globalIndex 槽位全局索引
 * @param columns 图集列数
 * @param rows 图集行数
 * @returns 归一化 UV 边界
 * @example calcAtlasUv(0, 8, 6) // { uMin: 0, vMin: 5/6, uMax: 1/8, vMax: 1 }
 */
export function calcAtlasUv(
  globalIndex: number,
  columns: number,
  rows: number,
): { uMin: number; vMin: number; uMax: number; vMax: number } {
  const col = globalIndex % columns
  const row = Math.floor(globalIndex / columns)
  const uMin = col / columns
  const uMax = (col + 1) / columns
  const vMin = 1 - (row + 1) / rows
  const vMax = 1 - row / rows
  return { uMin, vMin, uMax, vMax }
}

/**
 * 计算环旋转停止时对齐正前方（0 弧度）的目标旋转角度。
 *
 * @param slotIndex 要对齐的槽位索引
 * @param totalSlots 环总槽位数（默认 16）
 * @param extraRounds 额外旋转整圈数（默认 3）
 * @param direction 旋转方向：1 为顺时针，-1 为逆时针（默认 1）
 * @returns 最终旋转弧度
 * @example calcStopAngle(0, 16, 2, 1) // 4 * Math.PI
 */
export function calcStopAngle(
  slotIndex: number,
  totalSlots = SLOTS_PER_RING,
  extraRounds = 3,
  direction: 1 | -1 = 1,
): number {
  const slotAngle = (slotIndex / totalSlots) * Math.PI * 2
  const totalRotation = extraRounds * Math.PI * 2
  return direction * totalRotation - slotAngle
}

/**
 * 计算各环的旋转运动配置（速度、方向、停下时序）。
 *
 * @param ringIndex 环索引
 * @param totalRings 总环数
 * @param targetRingIndex 中奖环索引
 * @param targetRounds 中奖环额外整圈数（默认 4），其余环按距离递减，至少 2 圈
 * @returns 运动参数配置
 * @example calcRingMotion(1, 3, 1, 5)
 */
export function calcRingMotion(
  ringIndex: number,
  totalRings: number,
  targetRingIndex: number,
  targetRounds = DEFAULT_TARGET_ROUNDS,
): RingMotionConfig {
  const isTarget = ringIndex === targetRingIndex
  const direction: 1 | -1 = ringIndex % 2 === 0 ? 1 : -1
  if (isTarget) {
    return {
      direction,
      extraRounds: targetRounds,
      stopRatio: 1.0,
    }
  }
  const distFromTarget = Math.abs(ringIndex - targetRingIndex)
  const extraRounds = Math.max(2, targetRounds - Math.min(2, distFromTarget))
  // 所有转子同时停下
  return {
    direction,
    extraRounds,
    stopRatio: 1.0,
  }
}

/** 中奖环默认额外整圈数 */
export const DEFAULT_TARGET_ROUNDS = 4

/** 抽中后停顿时长（毫秒） */
export const SETTLE_HOLD_MS = 1000
/** 手动模式匀速旋转速度（弧度/毫秒，约 0.9 秒一圈） */
export const SPIN_RAD_PER_MS = (Math.PI * 2) / 900
/** 手动模式点停止后的减速时长（毫秒） */
export const MANUAL_STOP_MS = 1600
/** 三次缓出的起速是均速的 3 倍，行程按此折算以保证起速不低于匀速 */
const STOP_START_SPEED_DIV = 3

/**
 * 手动模式匀速旋转的当前角度。
 *
 * @param elapsedMs 开始旋转后经过的毫秒数（负数按 0）
 * @param direction 旋转方向
 * @param radPerMs 角速度（弧度/毫秒，默认 SPIN_RAD_PER_MS）
 * @returns 旋转弧度
 * @example calcSpinAngle(900, 1) // 约 2π
 */
export function calcSpinAngle(
  elapsedMs: number,
  direction: 1 | -1,
  radPerMs: number = SPIN_RAD_PER_MS,
): number {
  return direction * radPerMs * Math.max(0, elapsedMs)
}

/**
 * 手动停止：从当前角度出发，沿原方向减速到与目标对齐的最近角度（行程保证减速起速不低于匀速）。
 *
 * @param from 当前角度（弧度）
 * @param align 目标对齐角（任意同余角，如 calcStopAngle 的结果）
 * @param direction 旋转方向
 * @param durationMs 减速时长（毫秒）
 * @param radPerMs 匀速角速度（弧度/毫秒，默认 SPIN_RAD_PER_MS）
 * @returns 减速终点角度，与 align 同余，且沿 direction 方向不回头
 * @example calcStopTarget(1, calcStopAngle(3, 16, 4, 1), 1, MANUAL_STOP_MS)
 */
export function calcStopTarget(
  from: number,
  align: number,
  direction: 1 | -1,
  durationMs: number,
  radPerMs: number = SPIN_RAD_PER_MS,
): number {
  const full = Math.PI * 2
  const minTravel = (radPerMs * durationMs) / STOP_START_SPEED_DIV
  let d = (((direction * (align - from)) % full) + full) % full
  if (d < minTravel) d += full * Math.ceil((minTravel - d) / full)
  return from + direction * d
}

/** 动画期间（滚动/弹出/粒子）目标帧间隔：约 30fps */
export const ACTIVE_FRAME_MS = 1000 / 30
/** 结算后空闲慢转的目标帧间隔：约 15fps */
export const IDLE_FRAME_MS = 1000 / 15
/** 帧间隔判定容差（毫秒），吸收 60Hz 屏时间戳抖动 */
export const FRAME_TOLERANCE_MS = 4
/** 拖动：每像素水平位移对应的转子角度（弧度/像素，向右拖为正） */
export const DRAG_RAD_PER_PX = 0.0075
/** 拖动：判定水平意图所需的最小位移（像素） */
export const DRAG_INTENT_PX = 6
/** 惯性：速度指数衰减系数（每毫秒，越大停得越快，约 0.6 秒衰减到 1/e 以下） */
export const INERTIA_FRICTION = 0.004
/** 惯性：额外角速度小于此值视为结束（弧度/毫秒），此后回到纯慢转 */
export const INERTIA_STOP_SPEED = 0.0003
/** 惯性：松手角速度上限（弧度/毫秒），防止甩飞 */
export const INERTIA_MAX_SPEED = 0.012
/** 拖动：测速平滑系数（新样本权重） */
export const DRAG_VELOCITY_SMOOTH = 0.4
/** 拖动：停住超过此毫秒数再松手，视为无惯性 */
export const DRAG_HOLD_MS = 80
/** 像素比上限 */
export const MAX_PIXEL_RATIO = 1.25
/** 画布物理像素最长边上限 */
export const MAX_CANVAS_EDGE_PX = 600

/**
 * 判断本帧是否该真正渲染（时间戳节流）。
 *
 * @param now 当前时间戳（毫秒）
 * @param last 上次渲染时间戳（毫秒，0 表示还没渲染过）
 * @param intervalMs 目标帧间隔（毫秒）
 * @returns true 表示到点应渲染
 * @example shouldRenderFrame(1000, 970, ACTIVE_FRAME_MS) // false
 */
export function shouldRenderFrame(now: number, last: number, intervalMs: number): boolean {
  return last <= 0 || now - last >= intervalMs - FRAME_TOLERANCE_MS
}

/**
 * 计算像素比：不超过设备像素比、上限常量，且物理像素最长边不超过 MAX_CANVAS_EDGE_PX。
 *
 * @param dpr 设备像素比
 * @param cssW 画布 CSS 宽
 * @param cssH 画布 CSS 高
 * @returns 实际使用的像素比
 * @example calcPixelRatio(3, 400, 400) // 1.25
 */
export function calcPixelRatio(dpr: number, cssW: number, cssH: number): number {
  const edge = Math.max(cssW, cssH, 1)
  return Math.min(dpr, MAX_PIXEL_RATIO, MAX_CANVAS_EDGE_PX / edge)
}

/**
 * 把角度归一到 [0, 2π)（视觉等价，用于承接慢转角度作滚动起点）。
 *
 * @param angle 任意弧度
 * @returns 归一后的弧度
 * @example normalizeAngle(-Math.PI / 2) // 3π/2
 */
export function normalizeAngle(angle: number): number {
  const full = Math.PI * 2
  return ((angle % full) + full) % full
}

/**
 * 从起点角度按缓动比例逼近目标角度。
 *
 * @param start 起点角度
 * @param target 目标角度
 * @param eased 缓动后的进度 (0~1)
 * @returns 当前角度
 * @example calcApproachAngle(1, 5, 0.5) // 3
 */
export function calcApproachAngle(start: number, target: number, eased: number): number {
  return start + (target - start) * eased
}

/**
 * 拖动换算：起点角度加上水平位移对应的旋转量（向右拖角度增大）。
 *
 * @param startAngle 拖动开始时的角度（弧度）
 * @param dx 水平位移（像素，向右为正）
 * @returns 当前角度（弧度）
 * @example calcDragAngle(0, 100) // 0.75
 */
export function calcDragAngle(startAngle: number, dx: number): number {
  return startAngle + dx * DRAG_RAD_PER_PX
}

/**
 * 惯性单步：额外角速度按指数衰减，并给出这一步的角度增量。
 *
 * @param velocity 当前额外角速度（弧度/毫秒）
 * @param dtMs 经过的毫秒数
 * @returns delta 本步角度增量；velocity 衰减后的角速度（低于阈值归零）
 * @example calcInertiaStep(0.01, 16) // { delta: ~0.0155, velocity: ~0.0094 }
 */
export function calcInertiaStep(velocity: number, dtMs: number): { delta: number; velocity: number } {
  const dt = Math.max(0, dtMs)
  const decay = Math.exp(-INERTIA_FRICTION * dt)
  const next = velocity * decay
  return {
    delta: (velocity * (1 - decay)) / INERTIA_FRICTION,
    velocity: Math.abs(next) < INERTIA_STOP_SPEED ? 0 : next,
  }
}

/**
 * 判断是否为水平拖动意图：位移够大且横向分量占优。
 *
 * @param dx 水平位移（像素）
 * @param dy 竖直位移（像素）
 * @returns true 表示应接管为转子拖动
 * @example isHorizontalIntent(10, 3) // true
 */
export function isHorizontalIntent(dx: number, dy: number): boolean {
  return Math.abs(dx) >= DRAG_INTENT_PX && Math.abs(dx) > Math.abs(dy)
}

/**
 * 限制松手角速度的绝对值。
 *
 * @param velocity 角速度（弧度/毫秒）
 * @returns 限幅后的角速度
 * @example clampInertiaSpeed(1) // INERTIA_MAX_SPEED
 */
export function clampInertiaSpeed(velocity: number): number {
  return Math.max(-INERTIA_MAX_SPEED, Math.min(INERTIA_MAX_SPEED, velocity))
}

/**
 * 拖动测速：把新样本的瞬时角速度平滑并入旧值。
 *
 * @param prev 旧的平滑角速度（弧度/毫秒）
 * @param dAngle 本次角度变化（弧度）
 * @param dtMs 本次间隔（毫秒，非正时保持旧值）
 * @returns 新的平滑角速度
 * @example smoothDragVelocity(0, 0.1, 10) // 0.004
 */
export function smoothDragVelocity(prev: number, dAngle: number, dtMs: number): number {
  if (dtMs <= 0) return prev
  return prev + (dAngle / dtMs - prev) * DRAG_VELOCITY_SMOOTH
}


/** 一圈的弧度 */
const FULL_TURN = Math.PI * 2

/**
 * 圈/秒 换算成弧度/毫秒。
 *
 * @param rps 每秒圈数
 * @returns 弧度/毫秒
 * @example rpsToRadPerMs(1) // 2π / 1000
 */
export function rpsToRadPerMs(rps: number): number {
  return (rps * FULL_TURN) / 1000
}

/**
 * 圈/分 换算成弧度/毫秒。
 *
 * @param rpm 每分钟圈数
 * @returns 弧度/毫秒
 * @example rpmToRadPerMs(1.5) // 2π / 40000
 */
export function rpmToRadPerMs(rpm: number): number {
  return (rpm * FULL_TURN) / 60000
}

/**
 * 按抽奖转速与时长折算中奖环额外整圈数（至少 2 圈）。
 *
 * @param rps 抽奖转速（圈/秒，均速）
 * @param durationMs 转动时长（毫秒）
 * @returns 额外整圈数
 * @example calcTargetRounds(1, 5000) // 5
 */
export function calcTargetRounds(rps: number, durationMs: number): number {
  return Math.max(2, Math.round((rps * durationMs) / 1000))
}
