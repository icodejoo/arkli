<script setup lang="ts">
// 震动器：选预设或自己写「震/停」毫秒序列，调强度，开始/停止
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { showToast } from 'vant'
import { applyIntensity, canVibrate, chunkPattern, createPlayer, formatPattern, MAX_TOTAL_MS, MIN_INTENSITY, parsePattern, PRESETS, stopVibrate, totalDuration, vibratePattern } from './logic'

/** 强度滑杆刻度：百分比，最小对应 MIN_INTENSITY */
const SLIDER_MIN = Math.round(MIN_INTENSITY * 100)
/** 强度滑杆上限（百分比） */
const SLIDER_MAX = 100
/** 毫秒转秒 */
const MS_PER_S = 1000
/** 不支持时的提示 */
const TIP_UNSUPPORTED = '当前环境不支持网页震动：可能是设备没有马达，或系统关了触感反馈。'
/** 自定义序列的默认值 */
const DEFAULT_CUSTOM = '200,100,200'

/** 当前选中的预设 id；'custom' 表示用输入框 */
const selected = ref<string>(PRESETS[0].id)
/** 自定义序列文本 */
const customText = ref(DEFAULT_CUSTOM)
/** 强度百分比 */
const intensity = ref(SLIDER_MAX)
/** 是否循环 */
const loop = ref(false)
/** 是否正在播放 */
const playing = ref(false)
/** 是否支持震动 */
const supported = canVibrate()

/** 自定义序列的解析结果 */
const parsed = computed(() => parsePattern(customText.value))
/** 当前要播放的基础序列 */
const basePattern = computed<number[]>(() => (selected.value === 'custom' ? parsed.value.pattern : (PRESETS.find((p) => p.id === selected.value)?.pattern ?? [])))
/** 当前序列总时长文本 */
const durationText = computed(() => `${(totalDuration(basePattern.value) / MS_PER_S).toFixed(1)} 秒`)
/** 能否开始 */
const canStart = computed(() => supported && basePattern.value.length > 0)

/** 播放器：播完自然回到待机；调用震动统一走 vibratePattern */
const player = createPlayer({
  vibrate: (p) => vibratePattern(p),
  onEnd: () => (playing.value = false),
})

/** 选预设：同步到输入框方便在此基础上改；播放中先停 */
function pick(id: string): void {
  stop()
  selected.value = id
  const p = PRESETS.find((x) => x.id === id)
  if (p) customText.value = formatPattern(p.pattern)
}

/** 输入框被编辑，转为自定义模式 */
function onEdit(): void {
  stop()
  selected.value = 'custom'
}

/** 开始播放 */
function start(): void {
  if (!supported) {
    showToast(TIP_UNSUPPORTED)
    return
  }
  if (selected.value === 'custom' && parsed.value.error) {
    showToast(parsed.value.error)
    return
  }
  const shaped = applyIntensity(basePattern.value, intensity.value / SLIDER_MAX)
  playing.value = true
  player.start(chunkPattern(shaped), loop.value)
}

/** 停止播放并取消震动 */
function stop(): void {
  player.stop()
  playing.value = false
}

/** 页面切到后台就停，避免锁屏后还在震 */
function onVisibility(): void {
  if (document.hidden) stop()
}

onMounted(() => document.addEventListener('visibilitychange', onVisibility))
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  player.stop()
  stopVibrate()
})
</script>

<template>
  <div class="tool-page">
    <tool-group v-if="!supported">
      <p class="tool-hint vib__warn">{{ TIP_UNSUPPORTED }}</p>
    </tool-group>

    <tool-group title="节奏">
      <div class="vib__chips">
        <van-button v-for="p in PRESETS" :key="p.id" size="small" round :type="selected === p.id ? 'primary' : 'default'" @click="pick(p.id)">{{ p.name }}</van-button>
        <van-button size="small" round :type="selected === 'custom' ? 'primary' : 'default'" @click="selected = 'custom'">自定义</van-button>
      </div>
      <van-field
        v-model="customText"
        label="震/停(毫秒)"
        label-width="6.5em"
        placeholder="如 200,100,200"
        :error-message="selected === 'custom' ? (parsed.error ?? '') : ''"
        @update:model-value="onEdit"
      />
      <p class="tool-hint">奇数位是震动，偶数位是停顿，单位毫秒，逗号或空格隔开。总时长最多 {{ MAX_TOTAL_MS / MS_PER_S }} 秒，超出会被截断。</p>
      <p v-if="selected === 'custom' && parsed.truncated" class="tool-hint vib__warn">输入过长，已按上限截断。</p>
      <p class="tool-hint">这一轮约 {{ durationText }}</p>
    </tool-group>

    <tool-group :title="`强度 ${intensity}%`">
      <van-slider v-model="intensity" :min="SLIDER_MIN" :max="SLIDER_MAX" :disabled="playing" />
      <p class="tool-hint vib__gap">强度是用「开一下、关一下」的占空比凑出来的近似效果，不同手机的马达响应差别很大，有的几乎感觉不出区别。</p>
      <van-cell title="循环播放" center class="vib__loop">
        <van-switch v-model="loop" size="20" :disabled="playing" />
      </van-cell>
    </tool-group>

    <p class="tool-hint">首次震动前需要先点一下页面；系统开了勿扰或关了触感反馈时，部分手机会不震。切到后台会自动停止。</p>

    <!-- 底部动作栏：主按钮开始震动（震动中变成停止） -->
    <bottom-actions main :main-text="playing ? '停止' : '开始震动'" :main-type="playing ? 'danger' : 'primary'" :disabled="{ main: !playing && !canStart }" @main="playing ? stop() : start()" />
  </div>
</template>

<style lang="scss" scoped>
/* 预设按钮横排，放不下自动换行 */
.vib__chips {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  margin-bottom: $space-3;
}

/* 警示提示 */
.vib__warn {
  color: var(--c-warn-text);
}

/* 滑杆下方说明与上方留距 */
.vib__gap {
  margin-top: $space-3;
}

/* 循环开关那一行去掉背景，融进卡片 */
.vib__loop {
  margin-top: $space-2;
  background: transparent;
}
</style>
