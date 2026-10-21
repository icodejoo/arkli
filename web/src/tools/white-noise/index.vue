<script setup lang="ts">
// 白噪音：WebAudio 实时合成噪声循环播放，可调音量与定时关闭
import BottomActions from '@/shared/BottomActions.vue'
import { useFloatPause } from '@/shared/useFloatPause'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { showToast } from 'vant'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { BUFFER_SECONDS, clampVolume, DEFAULT_VOLUME, fillNoise, formatRemaining, MS_PER_MIN, NOISES, remainingMs, resumeEndAt, TIMER_OPTIONS, type NoiseKind } from './logic'

/** 音频不可用提示 */
const TIP_NO_AUDIO = '这个环境不支持音频播放'
/** 倒计时刷新间隔（毫秒） */
const TICK_MS = 500
/** 音量缓动时间常数（秒），避免爆音 */
const GAIN_SMOOTH = 0.05

/** 当前噪声类型 */
const kind = ref<NoiseKind>('rain')
/** 音量 0~100 */
const volume = ref(Math.round(DEFAULT_VOLUME * 100))
/** 是否正在播放 */
const playing = ref(false)
/** 定时关闭分钟数，0 为不定时 */
const timerMin = ref(0)
/** 定时选项：0 为不定时 */
const TIMER_PICK_OPTIONS: CellOption[] = [{ value: 0, label: '不定时' }, ...TIMER_OPTIONS.map((m) => ({ value: m, label: `${m} 分钟` }))]
/** 关闭时刻 */
const endAt = ref<number | null>(null)
/** 当前时刻（驱动倒计时显示） */
const now = ref(Date.now())

/** 音频上下文，首次点击播放时创建 */
let ctx: AudioContext | undefined
/** 增益节点 */
let gain: GainNode | undefined
/** 当前声源 */
let source: AudioBufferSourceNode | undefined
/** 倒计时句柄 */
let ticker: ReturnType<typeof setInterval> | undefined

/** 剩余时间文案 */
const remainText = computed(() => {
  const r = remainingMs(endAt.value, now.value)
  return r === null ? '' : formatRemaining(r)
})

/** 合成当前类型的缓冲并起播 */
function startSource(): void {
  if (!ctx || !gain) return
  const len = Math.floor(ctx.sampleRate * BUFFER_SECONDS)
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate)
  fillNoise(kind.value, buffer.getChannelData(0))
  source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = true
  source.connect(gain)
  source.start()
}

/** 停掉当前声源 */
function stopSource(): void {
  try {
    source?.stop()
  } catch {
    // 已停止，忽略
  }
  source?.disconnect()
  source = undefined
}

/** 把音量推给增益节点 */
function applyVolume(): void {
  if (ctx && gain) gain.gain.setTargetAtTime(clampVolume(volume.value / 100), ctx.currentTime, GAIN_SMOOTH)
}

/** 开始播放（须在用户点击里调用，才能创建/恢复 AudioContext） */
async function play(): Promise<void> {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) {
    showToast(TIP_NO_AUDIO)
    return
  }
  if (!ctx) {
    ctx = new Ctor()
    gain = ctx.createGain()
    gain.connect(ctx.destination)
  }
  await ctx.resume()
  applyVolume()
  stopSource()
  startSource()
  playing.value = true
  resetTimer()
}

/** 停止播放并清掉定时 */
function stop(): void {
  stopSource()
  void ctx?.suspend()
  playing.value = false
  endAt.value = null
  clearInterval(ticker)
  ticker = undefined
}

/** 按当前选择重置定时关闭 */
function resetTimer(): void {
  clearInterval(ticker)
  ticker = undefined
  if (!timerMin.value || !playing.value) {
    endAt.value = null
    return
  }
  endAt.value = Date.now() + timerMin.value * MS_PER_MIN
  startTicker()
}

/** 起定时关闭的倒计时刷新；到点停止播放。先清旧的，不会叠加 */
function startTicker(): void {
  clearInterval(ticker)
  now.value = Date.now()
  ticker = setInterval(() => {
    now.value = Date.now()
    if (remainingMs(endAt.value, now.value) === 0) {
      stop()
      showToast('定时到了，已关闭')
    }
  }, TICK_MS)
}

/** 切换噪声类型：播放中立即换声 */
function pick(k: NoiseKind): void {
  kind.value = k
  if (playing.value) {
    stopSource()
    startSource()
  }
}

/** 浮起时冻结的定时剩余毫秒；null 表示没有定时 */
let frozenRemain: number | null = null
/** 浮起时是否正在播放（决定恢复时要不要续播） */
let resumeAfterFloat = false

/**
 * 浮起 / 离开前台：播放中则静音挂起 AudioContext，定时关闭的倒计时一并冻结（剩余时间不在浮起期间流逝）。
 * 恢复时 resume 并以剩余时间重算关闭时刻。未在播放时什么都不做。
 */
useFloatPause({
  pause: () => {
    resumeAfterFloat = playing.value
    if (!resumeAfterFloat) return
    frozenRemain = endAt.value === null ? null : remainingMs(endAt.value, Date.now())
    clearInterval(ticker)
    ticker = undefined
    void ctx?.suspend()
  },
  resume: () => {
    if (!resumeAfterFloat) return
    resumeAfterFloat = false
    void ctx?.resume()
    if (frozenRemain !== null) {
      endAt.value = resumeEndAt(frozenRemain, Date.now())
      startTicker()
    }
    frozenRemain = null
  },
})

watch(volume, applyVolume)
watch(timerMin, resetTimer)
onBeforeUnmount(() => {
  stop()
  void ctx?.close()
})
</script>

<template>
  <div class="tool-page">
    <tool-group title="声音">
      <van-cell-group :border="false">
        <van-cell v-for="n in NOISES" :key="n.kind" :title="n.name" :label="n.desc" clickable center @click="pick(n.kind)">
          <template #right-icon><van-icon v-if="kind === n.kind" name="success" color="#07c160" /></template>
        </van-cell>
      </van-cell-group>
    </tool-group>

    <tool-group title="音量">
      <van-slider v-model="volume" :min="0" :max="100" />
    </tool-group>

    <tool-group>
      <cell-picker v-model="timerMin" title="定时关闭" :options="TIMER_PICK_OPTIONS" />
      <p v-if="remainText" class="tool-hint">剩余 {{ remainText }}</p>
    </tool-group>

    <p class="tool-hint">声音由手机实时合成，不占流量。建议把音量调低、放在枕边稍远处。</p>

    <bottom-actions :main-loading="playing" main :main-text="playing ? '停止' : '开始播放'" :main-type="playing ? 'warning' : 'primary'" @main="playing ? stop() : play()" />
  </div>
</template>
