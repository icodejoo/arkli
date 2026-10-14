/**
 * 噪音测量封装：开始、停止、订阅采样。
 * 对应原生 `native.noise.*` 与 `noise.sample` 事件，契约见 docs/design/bridge-protocol.md「噪音测量方法」。
 *
 * 原生用麦克风按 16kHz 采样，换算成「近似声压级」推送。数值没有经过校准，手机麦克风差异很大，仅供参考。
 * 无宿主时抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall, on as bridgeOn } from './bridge'
import { requireNative, type CallFn } from './system'
import type { OnFn } from './tts'

/** 方法名常量 */
export const NOISE_METHODS = {
  start: 'native.noise.start',
  stop: 'native.noise.stop',
} as const

/** 采样事件名 */
export const NOISE_EVENT_SAMPLE = 'noise.sample'

/** 一个窗口的采样 */
export interface NoiseSample {
  /** 近似声压级（未校准），0~140 */
  db: number
  /** 窗口峰值对应的近似声压级，0~140 */
  peakDb: number
  /** 窗口 RMS 的 dBFS，满量程为 0，静音约 -120 */
  rmsDbfs: number
}

/**
 * 开始测量。没有麦克风授权时原生会先申请；被拒时以 `PERMISSION_DENIED` 拒绝，已有一路在测时以 `NOT_READY` 拒绝。
 *
 * @param intervalMs 推送间隔毫秒（50~1000），缺省 100
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 实际采样率
 * @example const { sampleRate } = await startNoise(100)
 */
export async function startNoise(intervalMs?: number, call: CallFn = bridgeCall): Promise<{ sampleRate: number }> {
  requireNative(NOISE_METHODS.start)
  const params: Record<string, unknown> = {}
  if (intervalMs !== undefined) params.intervalMs = intervalMs
  const r = await call<{ started: boolean; sampleRate: number }>(NOISE_METHODS.start, params, { timeoutMs: 0 })
  return { sampleRate: r.sampleRate }
}

/**
 * 停止测量并释放麦克风；没在测也可以调用。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @example await stopNoise()
 */
export async function stopNoise(call: CallFn = bridgeCall): Promise<void> {
  requireNative(NOISE_METHODS.stop)
  await call(NOISE_METHODS.stop, {})
}

/**
 * 订阅采样事件。
 *
 * @param handler 每个窗口回调一次
 * @param on 事件订阅函数，默认走 bridge（仅测试注入）
 * @returns 取消订阅函数，页面卸载时务必调用
 * @example const off = onNoiseSample((s) => (db.value = s.db))
 */
export function onNoiseSample(handler: (s: NoiseSample) => void, on: OnFn = bridgeOn): () => void {
  return on(NOISE_EVENT_SAMPLE, (d) => handler(d as NoiseSample))
}
