<script setup lang="ts">
// 打字板：输入文字后全屏大字静止显示，点屏幕在编辑与展示间切换
import ColorPicker from '@/shared/ColorPicker.vue'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { showToast } from 'vant'
import { keepAwake } from '@/native/system'
import { createWakeLock } from '@/shared/wakelock'
import {
  type Align,
  BLINK_HZ_MAX,
  BLINK_HZ_MIN,
  blinkPeriod,
  cleanText,
  FONT_MAX,
  FONT_MIN,
  fitFontSize,
  invertColor,
  PRESETS,
  TEXT_MAX,
  WEIGHTS,
} from './logic'

/** 不支持常亮时的提示 */
const TIP_NO_WAKE = '这个系统不支持常亮，请在系统设置里调长息屏时间'
/** 粗细名称 */
const WEIGHT_NAMES: Record<number, string> = { 400: '常规', 700: '加粗', 900: '特粗' }
/** 展示层四周留白（像素） */
const STAGE_PAD = 16

/** 输入的文字 */
const text = ref(PRESETS[0].text)
/** 字色 */
const fg = ref(PRESETS[0].fg)
/** 背景色 */
const bg = ref(PRESETS[0].bg)
/** 是否自适应字号 */
const auto = ref(true)
/** 固定字号 */
const fixedSize = ref(120)
/** 字重 */
const weight = ref<number>(700)
/** 对齐 */
const align = ref<Align>('center')
/** 是否闪烁 */
const blink = ref(false)
/** 闪烁频率 */
const hz = ref(1)
/** 闪烁时是否反色 */
const invert = ref(false)
/** 是否处于展示模式 */
const showing = ref(false)
/** 自适应算出的字号 */
const autoSize = ref(FONT_MIN)
/** 展示层节点 */
const stageRef = ref<HTMLElement>()
/** 用于测量的隐藏节点 */
const probeRef = ref<HTMLElement>()
/** 网页常亮控制器（原生不可用时的兜底） */
const wake = createWakeLock()
/** 当前是否由原生持有常亮 */
let nativeAwake = false

/** 展示用字号 */
const fontSize = computed(() => (auto.value ? autoSize.value : fixedSize.value))
/** 展示层样式与 CSS 变量 */
const stageStyle = computed(() => ({
  '--fg': fg.value,
  '--bg': bg.value,
  '--fg2': invert.value ? invertColor(fg.value) : fg.value,
  '--bg2': invert.value ? invertColor(bg.value) : bg.value,
  '--fs': `${fontSize.value}px`,
  '--fw': weight.value,
  '--ta': align.value,
  '--period': `${blinkPeriod(hz.value)}s`,
}))
/** 闪烁动画名：反色闪换底色，普通闪只隐藏文字 */
const blinkClass = computed(() => (!blink.value ? '' : invert.value ? 'tb-stage--invert' : 'tb-stage--hide'))

/** 量某字号、宽度下文字的总高度 */
function measure(fs: number, width: number): number {
  const el = probeRef.value
  if (!el) return 0
  el.textContent = cleanText(text.value) || ' '
  el.style.fontSize = `${fs}px`
  el.style.width = `${width}px`
  return el.offsetHeight
}

/** 重新算自适应字号 */
async function refit(): Promise<void> {
  await nextTick()
  const w = window.innerWidth - STAGE_PAD * 2
  const h = window.innerHeight - STAGE_PAD * 2
  autoSize.value = fitFontSize(w, h, measure, FONT_MIN, FONT_MAX)
}

/** 申请常亮：先原生，不可用再退回网页 wakeLock */
async function acquireAwake(): Promise<void> {
  try {
    await keepAwake(true)
    nativeAwake = true
    return
  } catch {
    // 无宿主，走网页常亮
  }
  if (!(await wake.acquire())) showToast(TIP_NO_WAKE)
}

/** 释放两路常亮 */
async function releaseAwake(): Promise<void> {
  if (nativeAwake) {
    nativeAwake = false
    try {
      await keepAwake(false)
    } catch {
      // 忽略
    }
  }
  await wake.release()
}

/** 进入展示 */
async function show(): Promise<void> {
  text.value = cleanText(text.value)
  showing.value = true
  void refit()
  await acquireAwake()
}

/** 回到编辑 */
async function edit(): Promise<void> {
  showing.value = false
  await releaseAwake()
}

/** 套用预设 */
function applyPreset(i: number): void {
  const p = PRESETS[i]
  fg.value = p.fg
  bg.value = p.bg
  if (!text.value.trim()) text.value = p.text
}

watch([text, weight, auto], () => {
  if (showing.value) void refit()
})

/** 窗口尺寸变化（含横竖屏）时重算 */
function onResize(): void {
  if (showing.value) void refit()
}

onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  void releaseAwake()
})
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-field v-model="text" type="textarea" rows="2" autosize label="文字" placeholder="想让别人看到的话" :maxlength="TEXT_MAX" show-word-limit />
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">配色预设</h3>
      <div class="tb-presets">
        <van-button v-for="(p, i) in PRESETS" :key="p.name" size="small" round :style="{ background: p.bg, color: p.fg, borderColor: p.fg }" @click="applyPreset(i)">{{ p.name }}</van-button>
      </div>
      <div class="tb-colors">
        <label>字色 <color-picker v-model="fg" label="字色" /></label>
        <label>背景 <color-picker v-model="bg" label="背景色" /></label>
      </div>
    </div>

    <div class="tool-card">
      <van-cell-group :border="false">
        <van-cell title="自适应字号" center><template #value><van-switch v-model="auto" size="22" /></template></van-cell>
      </van-cell-group>
      <template v-if="!auto">
        <h3 class="tool-card__title tb-gap">字号 {{ fixedSize }}</h3>
        <van-slider v-model="fixedSize" :min="FONT_MIN" :max="FONT_MAX" :step="4" />
      </template>
      <h3 class="tool-card__title tb-gap">粗细</h3>
      <van-radio-group v-model="weight" direction="horizontal">
        <van-radio v-for="w in WEIGHTS" :key="w" :name="w">{{ WEIGHT_NAMES[w] }}</van-radio>
      </van-radio-group>
      <h3 class="tool-card__title tb-gap">对齐</h3>
      <van-radio-group v-model="align" direction="horizontal">
        <van-radio name="left">居左</van-radio>
        <van-radio name="center">居中</van-radio>
        <van-radio name="right">居右</van-radio>
      </van-radio-group>
    </div>

    <div class="tool-card">
      <van-cell-group :border="false">
        <van-cell title="闪烁" center><template #value><van-switch v-model="blink" size="22" /></template></van-cell>
        <template v-if="blink">
          <van-cell title="反色闪" label="底色与字色一起对调" center><template #value><van-switch v-model="invert" size="22" /></template></van-cell>
        </template>
      </van-cell-group>
      <template v-if="blink">
        <h3 class="tool-card__title tb-gap">频率 {{ hz }} Hz</h3>
        <van-slider v-model="hz" :min="BLINK_HZ_MIN" :max="BLINK_HZ_MAX" :step="0.5" />
      </template>
    </div>

    <van-button type="primary" block round @click="show">全屏展示</van-button>
    <p class="tool-hint">展示时点一下屏幕回到编辑，并会保持屏幕常亮。闪烁有光敏风险，请谨慎使用。</p>

    <div ref="probeRef" class="tb-probe" :style="{ fontWeight: weight }" aria-hidden="true" />

    <div v-if="showing" ref="stageRef" class="tb-stage" :class="blinkClass" :style="stageStyle" @click="edit">
      <div class="tb-stage__text">{{ text }}</div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tb-gap {
  margin-top: $space-4;
}

/* 预设按钮行 */
.tb-presets {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

/* 取色行 */
.tb-colors {
  display: flex;
  gap: $space-4;
  margin-top: $space-3;
  font-size: 14px;
}

/* 测量用节点：不可见、不占位，排版属性与展示层一致 */
.tb-probe {
  position: fixed;
  top: 0;
  left: -99999px;
  visibility: hidden;
  line-height: 1.25;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 全屏展示层 */
.tb-stage {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding: 16px;
  overflow: hidden;
  background: var(--bg);
  color: var(--fg);
  user-select: none;

  &__text {
    width: 100%;
    font-size: var(--fs);
    font-weight: var(--fw);
    line-height: 1.25;
    text-align: var(--ta);
    white-space: pre-wrap;
    word-break: break-all;
  }

  &--hide {
    animation: tb-hide var(--period) steps(1) infinite;
  }

  &--invert {
    animation: tb-invert var(--period) steps(1) infinite;
  }
}

/* 普通闪：后半周期字色变成底色 */
@keyframes tb-hide {
  50% {
    color: var(--bg);
  }
}

/* 反色闪：后半周期底色字色对调 */
@keyframes tb-invert {
  50% {
    color: var(--fg2);
    background: var(--bg2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tb-stage--hide,
  .tb-stage--invert {
    animation-duration: 2s;
  }
}
</style>
