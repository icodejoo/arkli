<script setup lang="ts">
// 掷骰子：选个数与面数，六面骰画点阵，其余面数直接显示数字
import { computed, onBeforeUnmount, ref } from 'vue'
import { prefersReducedMotion } from '@/shared/motion'
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

/** 当前展示的点数：滚动时是占位，停下后是结果 */
const shown = computed(() => (rolling.value ? tumble.value : (result.value?.values ?? [])))

/** 掷骰子：结果先定好，动画只做表演 */
function roll(): void {
  if (rolling.value) return
  const n = Math.min(MAX_DICE, Math.max(MIN_DICE, Math.floor(Number(count.value)) || MIN_DICE))
  count.value = n
  const r = rollDice(n, sides.value)
  if (prefersReducedMotion()) {
    result.value = r
    return
  }
  rolling.value = true
  const fake = () => rollDice(n, sides.value).values
  tumble.value = fake()
  ticker = setInterval(() => (tumble.value = fake()), TUMBLE_MS)
  timer = setTimeout(() => {
    clearInterval(ticker)
    result.value = r
    rolling.value = false
  }, ANIM_MS)
}

onBeforeUnmount(() => {
  clearTimeout(timer)
  clearInterval(ticker)
})
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
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
    </div>

    <div class="tool-card">
      <van-cell-group :border="false">
        <van-cell title="骰子个数" center>
          <template #value>
            <van-stepper v-model="count" :min="MIN_DICE" :max="MAX_DICE" integer :disabled="rolling" />
          </template>
        </van-cell>
      </van-cell-group>
      <h3 class="tool-card__title dice-sides-title">面数</h3>
      <van-radio-group v-model="sides" direction="horizontal" :disabled="rolling">
        <van-radio v-for="s in SIDES_OPTIONS" :key="s" :name="s">{{ s }} 面</van-radio>
      </van-radio-group>
    </div>

    <van-button type="primary" block round :disabled="rolling" @click="roll">掷！</van-button>
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
