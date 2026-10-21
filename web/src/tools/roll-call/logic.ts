// 随机点名：名单解析与抽签（随机函数可注入），名单存持久缓存
import { createToolStorage, type ToolStorage } from '../../shared/toolStorage'

/** 随机函数：返回 [0,1) */
export type Rand = () => number

/** 一次最多抽几人的上限 */
export const MAX_PICK = 20
/** 工具持久缓存的命名空间 */
export const TOOL_NS = 'roll-call'
/** 名单的缓存键 */
export const NAMES_STORE_KEY = 'names'
/** 旧版 localStorage 键（仅用于迁移） */
export const NAMES_KEY = 'arkli:roll-call:names'

/** 一次抽签的结果 */
export interface DrawResult {
  /** 本次抽中的人 */
  picked: string[]
  /** 抽完后的已抽集合（仅不重复模式有意义，重复模式原样返回） */
  used: string[]
  /** 还没被抽过的人数（重复模式等于名单总数） */
  left: number
  /** 不重复模式下名单已被抽空（本次抽到最后一人，或开抽前就已空） */
  exhausted: boolean
}

/**
 * 解析名单：按行拆分，去掉首尾空白与空行，重复姓名只留第一个。
 *
 * @param text 输入文本（每行一个，也兼容逗号、顿号、分号、制表符分隔）
 * @returns 名单
 * @example parseNames('张三\n李四\n张三') // ['张三', '李四']
 */
export function parseNames(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\r\n,，、;；\t]+/)) {
    const n = raw.trim()
    if (n && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

/**
 * 抽签：从候选里不放回地随机抽 count 个。
 *
 * @param names 名单
 * @param count 抽几个（1~MAX_PICK，超过候选数时抽完为止）
 * @param noRepeat 是否不重复（已抽过的不再进入候选）
 * @param used 已抽过的人（不重复模式用）
 * @param rand 随机函数（可注入）
 * @returns 抽签结果
 * @example drawNames(['a', 'b', 'c'], 2, true, [], () => 0) // picked: ['a', 'b']
 */
export function drawNames(names: readonly string[], count: number, noRepeat: boolean, used: readonly string[] = [], rand: Rand = Math.random): DrawResult {
  const usedSet = new Set(used)
  const pool = noRepeat ? names.filter((n) => !usedSet.has(n)) : names.slice()
  const want = Math.max(0, Math.min(Math.floor(count), MAX_PICK, pool.length))
  const picked: string[] = []
  for (let i = 0; i < want; i++) {
    const j = i + Math.min(pool.length - i - 1, Math.floor(rand() * (pool.length - i)))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
    picked.push(pool[i])
  }
  if (!noRepeat) return { picked, used: [...used], left: names.length, exhausted: false }
  const nextUsed = [...used, ...picked]
  const left = names.filter((n) => !new Set(nextUsed).has(n)).length
  return { picked, used: nextUsed, left, exhausted: left === 0 }
}

/**
 * 读取已存名单，失败返回空串；首次读取时迁移旧键。
 *
 * @param store 持久缓存，默认本工具命名空间
 * @returns 名单原文
 */
export function loadNames(store: ToolStorage = createToolStorage(TOOL_NS)): string {
  store.adoptLegacy(NAMES_KEY, NAMES_STORE_KEY, (raw) => raw)
  const v = store.get<unknown>(NAMES_STORE_KEY, '')
  return typeof v === 'string' ? v : ''
}

/**
 * 保存名单原文，失败静默忽略。
 *
 * @param text 名单原文
 * @param store 持久缓存，默认本工具命名空间
 * @returns 是否写入成功
 */
export function saveNames(text: string, store: ToolStorage = createToolStorage(TOOL_NS)): boolean {
  return store.set(NAMES_STORE_KEY, text)
}

/**
 * 校验缓存的抽取人数：1 到 MAX_PICK 的整数。
 *
 * @param v 缓存值
 * @returns 合法返回 true
 */
export function isValidCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_PICK
}

/** 主按钮状态输入 */
export interface MainButtonInput {
  /** 正在抽签表演中 */
  rolling: boolean
  /** 自动停止开关 */
  autoStop: boolean
  /** 手动模式下已点停止、正在减速 */
  stopping: boolean
  /** 正在识别名单（OCR） */
  ocrBusy: boolean
}

/** 主按钮展示状态 */
export interface MainButtonState {
  /** 文案 */
  text: string
  /** 是否禁用 */
  disabled: boolean
  /** 是否显示加载动画 */
  loading: boolean
  /** 是否红色（手动模式滚动中的“停止”） */
  danger: boolean
}

/** 主按钮文案：开抽 */
export const MAIN_TEXT_ROLL = '开抽'
/** 主按钮文案：停止 */
export const MAIN_TEXT_STOP = '停止'
/** 主按钮文案：识别中 */
export const MAIN_TEXT_OCR = '识别中'

/**
 * 计算主按钮状态：自动模式滚动中禁用并转圈；手动模式滚动中是红色可点的“停止”，减速中才禁用。
 *
 * @param s 当前页面状态
 * @returns 主按钮展示状态
 * @example calcMainButton({ rolling: true, autoStop: false, stopping: false, ocrBusy: false }) // 红色“停止”
 */
export function calcMainButton(s: MainButtonInput): MainButtonState {
  const manualSpin = s.rolling && !s.autoStop
  return {
    text: s.ocrBusy ? MAIN_TEXT_OCR : manualSpin ? MAIN_TEXT_STOP : MAIN_TEXT_ROLL,
    disabled: s.ocrBusy || (s.rolling && (s.autoStop || s.stopping)),
    loading: s.ocrBusy || (s.rolling && s.autoStop),
    danger: manualSpin && !s.stopping && !s.ocrBusy,
  }
}

/** 名单变化后重建 3D 预览的防抖时长（毫秒） */
export const PREVIEW_DEBOUNCE_MS = 400

/**
 * 名单的预览指纹：相同指纹不必重建转子。
 *
 * @param names 解析后的名单
 * @returns 指纹字符串（空名单为空串）
 * @example previewKey(['a', 'b']) // 'a\nb'
 */
export function previewKey(names: readonly string[]): string {
  return names.join('\n')
}

/**
 * 是否需要重建预览：名单有效且指纹与上次不同。
 *
 * @param names 解析后的名单
 * @param lastKey 上次已生成预览的指纹
 * @returns true 表示该重建
 * @example needsPreviewRebuild(['a'], '') // true
 */
export function needsPreviewRebuild(names: readonly string[], lastKey: string): boolean {
  return names.length > 0 && previewKey(names) !== lastKey
}

/** 防抖器 */
export interface Debouncer {
  /** 触发（重置计时） */
  call: () => void
  /** 取消尚未执行的触发 */
  cancel: () => void
}

/**
 * 创建防抖器：连续触发只在最后一次之后 ms 毫秒执行一次。
 *
 * @param fn 到点执行的函数
 * @param ms 防抖毫秒
 * @returns 防抖器
 * @example const d = createDebouncer(sync, PREVIEW_DEBOUNCE_MS); d.call()
 */
export function createDebouncer(fn: () => void, ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return {
    call() {
      cancel()
      timer = setTimeout(() => {
        timer = null
        fn()
      }, ms)
    },
    cancel,
  }
}
