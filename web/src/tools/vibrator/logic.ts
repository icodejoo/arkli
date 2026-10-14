// 震动器：节奏序列解析、预设、占空比强度近似、分块播放（纯逻辑，震动调用可注入）
import { isNativeAvailable } from '@/native/bridge'
import { cancelVibrate, vibrate } from '@/native/system'

/** 总时长上限（毫秒） */
export const MAX_TOTAL_MS = 30000
/** 单段时长上限（毫秒） */
export const MAX_SEGMENT_MS = 5000
/** 最多段数 */
export const MAX_SEGMENTS = 100
/** 一次 vibrate 调用最多放多少段：Chrome 对序列长度有上限（约 99），取偶数让每块都以「震」开头 */
export const CHUNK_SEGMENTS = 98
/** 占空比一个周期的毫秒数：太短马达跟不上，太长能感到断续 */
export const DUTY_PERIOD_MS = 40
/** 强度下限，再低马达基本不转 */
export const MIN_INTENSITY = 0.2
/** 序列里允许的分隔符：逗号、空白、分号、顿号（含全角） */
const SEPARATORS = /[\s,，;；、]+/
/** 取消震动用的参数 */
const CANCEL = 0

/** 解析结果 */
export interface ParseResult {
  /** 解析出的序列（震/停交替，毫秒），出错时为空 */
  pattern: number[]
  /** 是否因超长被截断 */
  truncated: boolean
  /** 错误说明，没错为 null */
  error: string | null
}

/** 预设节奏 */
export interface Preset {
  /** 标识 */
  id: string
  /** 中文名 */
  name: string
  /** 一句话说明 */
  desc: string
  /** 序列：震、停交替（毫秒） */
  pattern: number[]
}

/** 短点（SOS 里的 S）时长 */
const DOT_MS = 150
/** 长划（SOS 里的 O）时长 */
const DASH_MS = 450
/** SOS 字符内的间隔 */
const SOS_GAP_MS = 150
/** SOS 字母间的间隔 */
const SOS_LETTER_GAP_MS = 450
/** SOS 结尾的间隔 */
const SOS_END_GAP_MS = 1000

/**
 * 拼出 SOS 序列：三短三长三短。
 *
 * @returns 震/停交替的毫秒序列
 */
function buildSos(): number[] {
  const letter = (on: number): number[] => [on, SOS_GAP_MS, on, SOS_GAP_MS, on]
  return [...letter(DOT_MS), SOS_LETTER_GAP_MS, ...letter(DASH_MS), SOS_LETTER_GAP_MS, ...letter(DOT_MS), SOS_END_GAP_MS]
}

/**
 * 拼出渐强序列：震动一次比一次长，间隔固定。
 *
 * @returns 震/停交替的毫秒序列
 */
function buildRamp(): number[] {
  const out: number[] = []
  for (let on = 50; on <= 500; on += 75) out.push(on, 150)
  return out
}

/** 预设节奏列表 */
export const PRESETS: readonly Preset[] = [
  { id: 'heartbeat', name: '心跳', desc: '咚咚，停一下', pattern: [90, 90, 180, 700, 90, 90, 180, 700] },
  { id: 'sos', name: 'SOS', desc: '三短三长三短', pattern: buildSos() },
  { id: 'ramp', name: '渐强', desc: '一下比一下长', pattern: buildRamp() },
  { id: 'pulse', name: '脉冲', desc: '均匀的短震', pattern: [200, 200, 200, 200, 200, 200, 200, 200] },
]

/**
 * 解析用户输入的「震/停」毫秒序列。
 *
 * @param text 如 `200,100,200`，逗号/空格/分号/顿号都能分隔
 * @returns 解析结果；非法输入返回 error，过长时截断并置 truncated
 * @example
 * parsePattern('200, 100, 200') // { pattern: [200, 100, 200], truncated: false, error: null }
 */
export function parsePattern(text: string): ParseResult {
  const tokens = (text ?? '').split(SEPARATORS).filter((t) => t !== '')
  if (tokens.length === 0) return { pattern: [], truncated: false, error: '请输入至少一个时长，如 200,100,200' }
  const nums: number[] = []
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) return { pattern: [], truncated: false, error: `「${t}」不是有效的毫秒数，请只用正整数` }
    const n = Number(t)
    if (n <= 0) return { pattern: [], truncated: false, error: '每段时长要大于 0' }
    nums.push(n)
  }
  let truncated = false
  let list = nums
  if (list.length > MAX_SEGMENTS) {
    list = list.slice(0, MAX_SEGMENTS)
    truncated = true
  }
  const out: number[] = []
  let total = 0
  for (const n of list) {
    let v = n
    if (v > MAX_SEGMENT_MS) {
      v = MAX_SEGMENT_MS
      truncated = true
    }
    if (total + v > MAX_TOTAL_MS) {
      v = MAX_TOTAL_MS - total
      truncated = true
    }
    if (v <= 0) break
    out.push(v)
    total += v
    if (total >= MAX_TOTAL_MS) {
      if (out.length < list.length) truncated = true
      break
    }
  }
  return { pattern: out, truncated, error: null }
}

/**
 * 序列总时长。
 *
 * @param pattern 毫秒序列
 * @returns 总毫秒数
 * @example
 * totalDuration([200, 100, 200]) // 500
 */
export function totalDuration(pattern: readonly number[]): number {
  return pattern.reduce((a, b) => a + b, 0)
}

/**
 * 序列转成输入框里的文本。
 *
 * @param pattern 毫秒序列
 * @returns 逗号分隔的文本
 * @example
 * formatPattern([200, 100]) // "200,100"
 */
export function formatPattern(pattern: readonly number[]): string {
  return pattern.join(',')
}

/**
 * 用占空比近似强度：把每段「震」切成 40ms 周期里「开一小段、关一小段」。这只是近似，
 * 马达响应因机型而异，很多机器上差别不明显。
 *
 * @param pattern 震/停交替的毫秒序列
 * @param intensity 强度 0~1；>=1 原样返回，低于下限按下限算，非数字按 1
 * @returns 新序列，长度可能很长，播放前请用 chunkPattern 分块
 * @example
 * applyIntensity([80, 40], 0.5) // [20, 20, 20, 60]
 */
export function applyIntensity(pattern: readonly number[], intensity: number): number[] {
  const k = Number.isFinite(intensity) ? Math.min(1, Math.max(MIN_INTENSITY, intensity)) : 1
  if (k >= 1) return [...pattern]
  const on = Math.min(DUTY_PERIOD_MS - 1, Math.max(1, Math.round(DUTY_PERIOD_MS * k)))
  const off = DUTY_PERIOD_MS - on
  const out: number[] = []
  // 「震」段末尾剩下的不足一个「关」的时间，并进后面的「停」段，保证震/停严格交替
  let carry = 0
  pattern.forEach((d, i) => {
    if (i % 2 === 1) {
      out.push(d + carry)
      carry = 0
      return
    }
    let left = d
    while (left > 0) {
      const o = Math.min(on, left)
      out.push(o)
      left -= o
      if (left <= 0) break
      if (left <= off) {
        carry = left
        break
      }
      out.push(off)
      left -= off
    }
  })
  return out
}

/**
 * 把长序列切成每块不超过 max 段的小块，每块都以「震」开头。
 *
 * @param pattern 毫秒序列
 * @param max 每块最多段数，向下取偶数，至少 2
 * @returns 分块后的序列；空序列返回空数组
 * @example
 * chunkPattern([1, 2, 3, 4, 5], 2) // [[1, 2], [3, 4], [5]]
 */
export function chunkPattern(pattern: readonly number[], max = CHUNK_SEGMENTS): number[][] {
  const size = Math.max(2, Math.floor(max / 2) * 2)
  const out: number[][] = []
  for (let i = 0; i < pattern.length; i += size) out.push(pattern.slice(i, i + size))
  return out
}

/** 震动能力的最小接口（navigator 或测试用假对象） */
export interface VibrateNav {
  /** 震动；0 或空数组取消 */
  vibrate?: (pattern: number | number[]) => boolean
}

/**
 * 当前环境是否支持震动。
 *
 * 不传 nav 时：在 Arkli 容器内一律认为支持（由原生判断有没有马达），否则看全局 navigator。
 *
 * @param nav 导航对象，测试时注入；不传走上述默认判断
 * @returns 支持为 true
 * @example
 * canVibrate({ vibrate: () => true }) // true
 */
export function canVibrate(nav?: VibrateNav): boolean {
  if (nav === undefined) {
    if (isNativeAvailable()) return true
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
  }
  return typeof nav.vibrate === 'function'
}

/**
 * 触发震动或取消（封装点）。默认走 `@/native/system` 的 `vibrate` / `cancelVibrate`
 * （容器内用原生，浏览器自动退回 navigator），不等结果，失败静默；传入 nav 时直接调它（测试用）。
 *
 * @param pattern 毫秒数，或 `[震, 停, 震…]` 序列（浏览器习惯的顺序）；传 0 / 空数组表示取消
 * @param nav 导航对象，测试时注入；不传走原生封装
 * @returns 已发出为 true；注入的 nav 不支持或抛错为 false
 * @example
 * vibratePattern([200, 100, 200])
 * vibratePattern(0) // 取消
 */
export function vibratePattern(pattern: number | number[], nav?: VibrateNav): boolean {
  if (nav !== undefined) {
    if (!canVibrate(nav)) return false
    try {
      return nav.vibrate!(pattern) !== false
    } catch {
      return false
    }
  }
  const cancel = pattern === CANCEL || (Array.isArray(pattern) && pattern.length === 0)
  // 原生序列是 [停, 震, ...]，浏览器习惯 [震, 停, ...]，前面补一个 0 的停顿对齐
  const task = cancel ? cancelVibrate() : vibrate(typeof pattern === 'number' ? pattern : [0, ...pattern])
  task.catch(() => undefined)
  return true
}

/**
 * 立即停止震动。
 *
 * @param nav 导航对象，测试时注入；不传走原生封装
 * @returns 是否已发出
 * @example
 * stopVibrate()
 */
export function stopVibrate(nav?: VibrateNav): boolean {
  return vibratePattern(CANCEL, nav)
}

/** 播放器 */
export interface Player {
  /** 开始播放（会先停掉上一次） */
  start(chunks: number[][], loop: boolean): void
  /** 停止并取消震动 */
  stop(): void
}

/** 播放器依赖 */
export interface PlayerDeps {
  /** 触发一块震动，返回是否成功 */
  vibrate: (pattern: number | number[]) => boolean
  /** 自然播完（非循环）时回调；手动 stop 不回调 */
  onEnd: () => void
}

/**
 * 创建分块播放器：Chrome 限制单次序列长度，所以按块依次触发，靠定时器衔接。
 *
 * @param deps 震动函数与结束回调
 * @returns 播放器；卸载页面时必须调用 stop
 * @example
 * const p = createPlayer({ vibrate: vibratePattern, onEnd: () => {} })
 * p.start(chunkPattern([200, 100, 200]), false)
 * p.stop()
 */
export function createPlayer(deps: PlayerDeps): Player {
  let timer: ReturnType<typeof setTimeout> | undefined
  let token = 0
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  return {
    start(chunks, loop) {
      clear()
      const mine = ++token
      const list = chunks.filter((c) => c.length > 0)
      if (list.length === 0) {
        deps.onEnd()
        return
      }
      let idx = 0
      const next = (): void => {
        if (mine !== token) return
        if (idx >= list.length) {
          if (!loop) {
            timer = undefined
            deps.onEnd()
            return
          }
          idx = 0
        }
        const chunk = list[idx++]
        deps.vibrate(chunk)
        timer = setTimeout(next, totalDuration(chunk))
      }
      next()
    },
    stop() {
      token++
      clear()
      deps.vibrate(CANCEL)
    },
  }
}
