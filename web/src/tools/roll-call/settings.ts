// 随机点名的共享设置：设置页与主页面（keep-alive 缓存的另一个组件实例）共用同一份响应式状态。
import { ref, type Ref } from 'vue'
import { createToolStorage, type ToolStorage } from '../../shared/toolStorage'
import { usePersistedRef } from '../../shared/usePersistedRef'
import { TOOL_NS } from './logic'

/** “不重复”缓存键 */
export const KEY_NO_REPEAT = 'noRepeat'
/** “自动停止”缓存键 */
export const KEY_AUTO_STOP = 'autoStop'
/** “转动时长”缓存键 */
export const KEY_SPIN_SECONDS = 'spinSeconds'
/** 转动时长默认值（秒） */
export const DEFAULT_SPIN_SECONDS = 5
/** 转动时长下限（秒） */
export const MIN_SPIN_SECONDS = 3
/** 转动时长上限（秒） */
export const MAX_SPIN_SECONDS = 15
/** 转动时长校验 */
const isSpinSeconds = (v: unknown): boolean =>
  typeof v === 'number' && v >= MIN_SPIN_SECONDS && v <= MAX_SPIN_SECONDS
/** 数值设置项的定义：缓存键、默认值与范围 */
export interface NumSettingDef {
  /** 缓存键 */
  key: string
  /** 默认值 */
  def: number
  /** 下限 */
  min: number
  /** 上限 */
  max: number
  /** 步进 */
  step: number
}

/** 结算后转子高斯模糊半径（px） */
export const BLUR_DEF: NumSettingDef = { key: 'blurPx', def: 1.5, min: 0, max: 6, step: 0.5 }
/** 闲时转速（圈/分） */
export const IDLE_RPM_DEF: NumSettingDef = { key: 'idleRpm', def: 1.5, min: 0.5, max: 6, step: 0.5 }
/** 抽奖转速（圈/秒） */
export const SPIN_RPS_DEF: NumSettingDef = { key: 'spinRps', def: 1, min: 0.5, max: 4, step: 0.5 }
/** 数值范围校验工厂 */
const inRange = (d: NumSettingDef) => (v: unknown): boolean =>
  typeof v === 'number' && v >= d.min && v <= d.max
/** 布尔值校验 */
const isBool = (v: unknown): boolean => typeof v === 'boolean'

/** 点名设置与关联状态 */
export interface RollCallSettings {
  /** 不重复模式（持久化） */
  noRepeat: Ref<boolean>
  /** 自动停止（持久化）：开则自动停，关则手动停 */
  autoStop: Ref<boolean>
  /** 转动时长秒数（持久化）：仅自动停止时生效 */
  spinSeconds: Ref<number>
  /** 结算模糊半径（持久化） */
  blurPx: Ref<number>
  /** 闲时转速（持久化） */
  idleRpm: Ref<number>
  /** 抽奖转速（持久化） */
  spinRps: Ref<number>
  /** 已抽过的人（仅内存） */
  used: Ref<string[]>
  /** 重置计数：每次 resetUsed 自增，主页面据此清掉已展示结果 */
  resetSeq: Ref<number>
  /** 清空已抽记录并通知主页面清结果 */
  resetUsed: () => void
}

/**
 * 创建一份设置状态。
 * @param store 持久缓存实例
 * @returns 设置状态
 * @example const s = createRollCallSettings(createToolStorage('roll-call'))
 */
export function createRollCallSettings(store: ToolStorage): RollCallSettings {
  const used = ref<string[]>([])
  const resetSeq = ref(0)
  return {
    noRepeat: usePersistedRef<boolean>(store, KEY_NO_REPEAT, false, isBool),
    autoStop: usePersistedRef<boolean>(store, KEY_AUTO_STOP, true, isBool),
    spinSeconds: usePersistedRef<number>(store, KEY_SPIN_SECONDS, DEFAULT_SPIN_SECONDS, isSpinSeconds),
    blurPx: usePersistedRef<number>(store, BLUR_DEF.key, BLUR_DEF.def, inRange(BLUR_DEF)),
    idleRpm: usePersistedRef<number>(store, IDLE_RPM_DEF.key, IDLE_RPM_DEF.def, inRange(IDLE_RPM_DEF)),
    spinRps: usePersistedRef<number>(store, SPIN_RPS_DEF.key, SPIN_RPS_DEF.def, inRange(SPIN_RPS_DEF)),
    used,
    resetSeq,
    resetUsed: () => {
      used.value = []
      resetSeq.value++
    },
  }
}

/** 模块级单例 */
let shared: RollCallSettings | null = null

/**
 * 取共享设置（模块级单例，设置页与主页面拿到同一份）。
 * @returns 设置状态
 * @example const { noRepeat, autoStop } = useRollCallSettings()
 */
export function useRollCallSettings(): RollCallSettings {
  return (shared ??= createRollCallSettings(createToolStorage(TOOL_NS)))
}
