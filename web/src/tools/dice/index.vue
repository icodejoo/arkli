<script setup lang="ts">
// 掷骰子：选个数与面数，六面骰画点阵，其余面数直接显示数字
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { prefersReducedMotion } from '@/shared/motion'
import { loadFlag, saveFlag, SOUND_KEY, VIBRATE_KEY, VIBRATE_LAND, VIBRATE_START } from '../coin-flip/logic'
import { createSoundPlayer, tryVibrate } from '../coin-flip/feedback'
import { MAX_DICE, MIN_DICE, PIPS, rollDice, SIDES_OPTIONS, type RollResult } from './logic'

/** 动画时长（毫秒） */
const ANIM_MS = 600
/** 滚动时占位点数的刷新间隔（毫秒） */
const TUMBLE_MS = 90

/** 骰子个数 */
const count = ref(2)
/** 面数 */
const sides = ref<number>(6)
/** 最近一次结果 */
const result = ref<RollResult | null>(null)
/** 是否正在滚动 */
const rolling = ref(false)
/** 滚动时显示的占位点数 */
const tumble = ref<number[]>([])
/** 定时器句柄 */
let timer: ReturnType<typeof setTimeout> | undefined
/** 滚动中的随机跳动句柄 */
let ticker: ReturnType<typeof setInterval> | undefined
/** 取 localStorage，不可用时为 undefined */
function getStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}
/** 震动反馈开关，默认开（与抛硬币共用设置） */
const vibrateOn = ref(loadFlag(getStorage(), VIBRATE_KEY, true))
/** 音效开关，默认关 */
const soundOn = ref(loadFlag(getStorage(), SOUND_KEY, false))
/** 合成音播放器 */
const sound = createSoundPlayer()

/** 开关变化时落盘 */
watch(vibrateOn, (v) => saveFlag(getStorage(), VIBRATE_KEY, v))
watch(soundOn, (v) => saveFlag(getStorage(), SOUND_KEY, v))

/** 触发某个时刻的反馈（震动与音效各自看开关） */
function feedback(kind: 'start' | 'land'): void {
  if (vibrateOn.value) void tryVibrate(kind === 'start' ? VIBRATE_START : VIBRATE_LAND)
  if (soundOn.value) sound.play(kind)
}

/** 当前展示的点数：滚动时是占位，停下后是结果 */
const shown = computed(() => (rolling.value ? tumble.value : (result.value?.values ?? [])))

/** 掷骰子：结果先定好，动画只做表演 */
function roll(): void {
  if (rolling.value) return
  // AudioContext 必须在用户手势里创建 / resume
  if (soundOn.value) sound.unlock()
  const n = Math.min(MAX_DICE, Math.max(MIN_DICE, Math.floor(Number(count.value)) || MIN_DICE))
  count.value = n
  const r = rollDice(n, sides.value)
  if (prefersReducedMotion()) {
    result.value = r
    feedback('land')
    return
  }
  rolling.value = true
  feedback('start')
  const fake = () => rollDice(n, sides.value).values
  tumble.value = fake()
  ticker = setInterval(() => (tumble.value = fake()), TUMBLE_MS)
  timer = setTimeout(() => {
    clearInterval(ticker)
    result.value = r
    rolling.value = false
    feedback('land')
  }, ANIM_MS)
}

onBeforeUnmount(() => {
  clearTimeout(timer)
  clearInterval(ticker)
  sound.dispose()
})
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <div class="dice" :class="{ 'dice--rolling': rolling }" aria-live="polite">
        <template v-if="shown.length">
          <div v-for="(v, i) in shown" :key="i" class="die" :class="{ 'die--num': sides !== 6 }">
            <template v-if="sides === 6">
              <span v-for="c in 9" :key="c" class="pip" :class="{ 'pip--on': PIPS[v]?.includes(c - 1) }" />
            </template>
            <template v-else>{{ v }}</template>
          </div>
        </template>
        <p v-else class="tool-hint">点下面的按钮掷骰子</p>
      </div>
      <p v-if="result && !rolling && result.values.length > 1" class="dice-sum">合计 {{ result.sum }}</p>
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <van-cell title="骰子个数" center>
          <template #value>
            <van-stepper v-model="count" :min="MIN_DICE" :max="MAX_DICE" integer :disabled="rolling" />
          </template>
        </van-cell>
      </van-cell-group>
      <h3 class="tool-group__title dice-sides-title">面数</h3>
      <van-radio-group v-model="sides" direction="horizontal" :disabled="rolling">
        <van-radio v-for="s in SIDES_OPTIONS" :key="s" :name="s">{{ s }} 面</van-radio>
      </van-radio-group>
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <van-cell title="震动反馈" center>
          <template #right-icon><van-switch v-model="vibrateOn" size="20" /></template>
        </van-cell>
        <van-cell title="音效" center>
          <template #right-icon><van-switch v-model="soundOn" size="20" /></template>
        </van-cell>
      </van-cell-group>
    </tool-group>

    <!-- 底部动作栏：主按钮掷骰子 -->
    <bottom-actions main main-text="掷！" :disabled="{ main: rolling }" @main="roll" />
  </div>
</template>

<style lang="scss" scoped>
/* 合计文字 */
.dice-sum {
  margin: $space-3 0 0;
  text-align: center;
  font-size: 20px;
  font-weight: 600;
  color: var(--c-text);
}

/* 面数标题与上方留距 */
.dice-sides-title {
  margin-top: $space-3;
}

/* 骰子排布区 */
.dice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: $space-3;
  min-height: 96px;
}

/* 骰面：白底黑点是内容色，不随深色模式变 */
.die {
  display: grid;
  grid-template: repeat(3, 1fr) / repeat(3, 1fr);
  width: 80px;
  height: 80px;
  padding: 10px;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 2px 0 #cfd3da, 0 0 0 1px #e1e4ea;

  &--num {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--c-primary);
    color: var(--c-on-primary);
    font-size: 28px;
    font-weight: 700;
    box-shadow: none;
  }
}

.dice--rolling .die {
  animation: shake 0.18s linear infinite;
}

@keyframes shake {
  50% {
    transform: rotate(8deg) translateY(-4px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dice--rolling .die {
    animation: none;
  }
}

/* 点阵里的一个点 */
.pip {
  place-self: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;

  &--on {
    background: #1b1d22;
  }
}
</style>
