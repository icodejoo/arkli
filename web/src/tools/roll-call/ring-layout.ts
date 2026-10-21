/**
 * 随机点名 3D 滚筒：环布局、几何参数、旋转停靠与图集 UV 纯逻辑计算。
 */

/** 每环固定槽位数 */
export const SLOTS_PER_RING = 16

/** 滚筒最少环数，保证 3D 立体滚筒视觉 */
export const MIN_RINGS = 3

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
 * @returns 运动参数配置
 * @example calcRingMotion(1, 3, 1)
 */
export function calcRingMotion(
  ringIndex: number,
  totalRings: number,
  targetRingIndex: number,
): RingMotionConfig {
  const isTarget = ringIndex === targetRingIndex
  const direction: 1 | -1 = ringIndex % 2 === 0 ? 1 : -1
  if (isTarget) {
    return {
      direction,
      extraRounds: 4,
      stopRatio: 1.0,
    }
  }
  const distFromTarget = Math.abs(ringIndex - targetRingIndex)
  const maxDist = Math.max(1, Math.max(targetRingIndex, totalRings - 1 - targetRingIndex))
  const ratioOffset = (distFromTarget / maxDist) * 0.25
  const stopRatio = Math.max(0.55, 0.85 - ratioOffset)
  const extraRounds = Math.max(2, 4 - Math.min(2, distFromTarget))
  return {
    direction,
    extraRounds,
    stopRatio,
  }
}
