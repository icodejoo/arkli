<script setup lang="ts">
// 摩斯电码：文本与摩斯互转，可调 WPM 与频率，用 WebAudio 发声播放
import BottomActions from '@/shared/BottomActions.vue'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { computed, onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { buildTimeline, FREQ_MAX, FREQ_MIN, morseToText, textToMorse, timelineDuration, WPM_MAX, WPM_MIN } from './logic'

/** 起音与收音的淡入淡出时长（秒），避免咔哒声 */
const RAMP_S = 0.005
/** 音量 */
const GAIN = 0.3
/** 播放前的缓冲（秒） */
const LEAD_S = 0.05

/** 转换方向选项 */
const MODE_OPTIONS: readonly CellOption[] = [
  { value: 'encode', label: '文本 → 摩斯' },
  { value: 'decode', label: '摩斯 → 文本' },
]

/** 方向：文本转摩斯，或摩斯转文本 */
const mode = ref<'encode' | 'decode'>('encode')
/** 输入内容 */
const input = ref('')
/** 每分钟字数 */
const wpm = ref(15)
/** 音调频率（Hz） */
const freq = ref(600)
/** 是否正在播放 */
const playing = ref(false)

/** 文本转摩斯结果 */
const encoded = computed(() => textToMorse(input.value))
/** 摩斯转文本结果 */
const decoded = computed(() => morseToText(input.value))
/** 摩斯串（播放与复制用）：加密模式取转换结果，解码模式取输入 */
const morse = computed(() => (mode.value === 'encode' ? encoded.value.morse : input.value))
/** 输出文本 */
const output = computed(() => (mode.value === 'encode' ? encoded.value.morse : decoded.value.text))
/** 提示文案 */
const notice = computed(() => {
  if (mode.value === 'encode') {
    if (encoded.value.hasChinese) return '中文电码需要几千条码表，这里不支持，中文已跳过。'
    if (encoded.value.unsupported.length) return `不支持：${encoded.value.unsupported.join(' ')}，已跳过。`
    return ''
  }
  return decoded.value.unknown.length ? `认不出：${decoded.value.unknown.join(' ')}` : ''
})
/** 预计播放时长（秒） */
const seconds = computed(() => (timelineDuration(buildTimeline(morse.value, wpm.value)) / 1000).toFixed(1))

/** 音频上下文，首次播放时才创建（需要用户手势） */
let ctx: AudioContext | null = null
/** 当前振荡器 */
let osc: OscillatorNode | null = null
/** 播放结束计时器 */
let endTimer: ReturnType<typeof setTimeout> | undefined

/** 停止播放并释放振荡器 */
function stop(): void {
  clearTimeout(endTimer)
  if (osc) {
    try {
      osc.stop()
    } catch {
      // 已经停过了
    }
    osc.disconnect()
    osc = null
  }
  playing.value = false
}

/** 播放：把时间线用增益包络一次性排进 AudioContext，避免逐段定时器的抖动 */
async function play(): Promise<void> {
  if (playing.value) return
  const timeline = buildTimeline(morse.value, wpm.value)
  if (!timeline.length) {
    showFailToast('没有可播放的内容')
    return
  }
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) {
    showFailToast('这个环境不支持音频播放')
    return
  }
  try {
    ctx = ctx ?? new AC()
    // 自动播放策略下可能处于 suspended，需要在手势里 resume
    if (ctx.state === 'suspended') await ctx.resume()
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(ctx.destination)
    osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq.value
    osc.connect(gain)
    const t0 = ctx.currentTime + LEAD_S
    for (const b of timeline) {
      if (!b.on) continue
      const s = t0 + b.start / 1000
      const e = s + b.duration / 1000
      gain.gain.setValueAtTime(0, s)
      gain.gain.linearRampToValueAtTime(GAIN, s + RAMP_S)
      gain.gain.setValueAtTime(GAIN, Math.max(s + RAMP_S, e - RAMP_S))
      gain.gain.linearRampToValueAtTime(0, e)
    }
    const total = timelineDuration(timeline) / 1000
    osc.start(t0)
    osc.stop(t0 + total + RAMP_S)
    playing.value = true
    endTimer = setTimeout(stop, (total + LEAD_S + RAMP_S) * 1000 + 50)
  } catch {
    stop()
    showFailToast('播放失败')
  }
}

/** 复制输出 */
async function copy(): Promise<void> {
  if (!output.value) return
  if (await copyText(output.value)) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按文字手动选择')
}

onBeforeUnmount(() => {
  stop()
  if (ctx) {
    void ctx.close()
    ctx = null
  }
})
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <cell-picker v-model="mode" title="模式" :options="MODE_OPTIONS" />
    </tool-group>

    <tool-group>
      <van-field
        v-model="input"
        type="textarea"
        rows="3"
        autosize
        clearable
        :spellcheck="false"
        :placeholder="mode === 'encode' ? '输入英文、数字或常用标点' : '点用 . 划用 -，字符间空格，单词间 /'"
      />
      <p v-if="notice" class="tool-hint morse-notice">{{ notice }}</p>
    </tool-group>

    <tool-group :title="`${mode === 'encode' ? '摩斯码' : '文本'}`">
      <p class="morse-out">{{ output || '（结果显示在这里）' }}</p>
    </tool-group>

    <tool-group title="播放设置">
      <div class="morse-row">
        <span class="morse-row__k">速度 {{ wpm }} WPM</span>
        <van-slider v-model="wpm" class="morse-row__bar" :min="WPM_MIN" :max="WPM_MAX" />
      </div>
      <div class="morse-row">
        <span class="morse-row__k">音调 {{ freq }} Hz</span>
        <van-slider v-model="freq" class="morse-row__bar" :min="FREQ_MIN" :max="FREQ_MAX" :step="10" :disabled="playing" />
      </div>
      <p class="tool-hint">预计 {{ seconds }} 秒。点 1 : 划 3 : 字符间隔 3 : 单词间隔 7。</p>
    </tool-group>

    <!-- 底部动作栏：复制结果，主按钮播放（播放中变成停止） -->
    <bottom-actions :actions="{ copy: { disabled: !output } }" main :main-text="playing ? '停止' : '播放'" :main-type="playing ? 'danger' : 'primary'" :disabled="{ main: !playing && !morse.trim() }" @main="playing ? stop() : play()" @copy="copy" />
  </div>
</template>

<style lang="scss" scoped>
/* 提示文字与上方留距 */
.morse-notice {
  margin-top: $space-2;
}

/* 输出串 */
.morse-out {
  margin: 0 0 $space-3;
  font: 16px ui-monospace, Menlo, Consolas, monospace;
  word-break: break-all;
  white-space: pre-wrap;
  color: var(--c-text);
}

/* 滑杆一行 */
.morse-row {
  display: flex;
  align-items: center;
  gap: $space-3;
  padding: $space-2 0;

  &__k {
    flex: 0 0 110px;
    color: var(--c-text-muted);
    font-size: 13px;
  }

  &__bar {
    flex: 1;
  }
}
</style>
