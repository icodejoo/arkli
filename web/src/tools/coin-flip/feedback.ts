// 抛硬币 / 掷骰子共用的反馈：震动与 WebAudio 合成音（不引音频文件）
import { vibrate } from '@/native/system'
import { envelopePoints, toneSpecs, type FeedbackKind } from './logic'

/** AudioContext 构造器形状（含旧前缀） */
type AudioCtor = new () => AudioContext

/**
 * 震动一下；任何失败（无宿主且不支持、原生报错）都静默忽略。
 *
 * @param pattern 节奏，`[停, 震, ...]` 毫秒
 * @example
 * void tryVibrate([0, 30])
 */
export async function tryVibrate(pattern: readonly number[]): Promise<void> {
  try {
    await vibrate([...pattern])
  } catch {
    // NativeUnavailableError 或原生失败：不打扰用户
  }
}

/** 音效播放器 */
export interface SoundPlayer {
  /** 在用户点击里调用：创建并 resume AudioContext；不支持时无副作用 */
  unlock(): void
  /** 播放某事件的合成音；未解锁或不支持时静默 */
  play(kind: FeedbackKind): void
  /** 关闭 AudioContext，卸载时调用 */
  dispose(): void
}

/**
 * 创建音效播放器。AudioContext 惰性创建，须由 {@link SoundPlayer.unlock} 在点击里触发。
 *
 * @returns 播放器
 * @example
 * const sound = createSoundPlayer()
 * onClick: sound.unlock(); sound.play('start')
 */
export function createSoundPlayer(): SoundPlayer {
  let ctx: AudioContext | undefined
  return {
    unlock() {
      try {
        if (!ctx) {
          const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }
          const Ctor = w.AudioContext ?? w.webkitAudioContext
          if (!Ctor) return
          ctx = new Ctor()
        }
        if (ctx.state === 'suspended') void ctx.resume()
      } catch {
        ctx = undefined
      }
    },
    play(kind) {
      const c = ctx
      if (!c) return
      try {
        const now = c.currentTime
        for (const spec of toneSpecs(kind)) {
          const osc = c.createOscillator()
          const gain = c.createGain()
          osc.type = spec.type
          osc.frequency.value = spec.freq
          const t0 = now + spec.startMs / 1000
          const pts = envelopePoints(spec)
          gain.gain.setValueAtTime(pts[0].v, t0)
          for (const p of pts.slice(1)) {
            if (p.ramp === 'exp') gain.gain.exponentialRampToValueAtTime(p.v, t0 + p.t)
            else gain.gain.linearRampToValueAtTime(p.v, t0 + p.t)
          }
          osc.connect(gain)
          gain.connect(c.destination)
          osc.start(t0)
          osc.stop(t0 + spec.durMs / 1000 + 0.02)
        }
      } catch {
        // 合成失败不影响主流程
      }
    },
    dispose() {
      try {
        void ctx?.close()
      } catch {
        // 已关闭时忽略
      }
      ctx = undefined
    },
  }
}
