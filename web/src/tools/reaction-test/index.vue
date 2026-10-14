<script setup lang="ts">
// 反应力测试：等屏幕变绿再点，毫秒计时；提前点算犯规，5 轮取平均
import { computed, onBeforeUnmount, ref } from 'vue'
import { gradeFor, isNewBest, isSuspicious, loadBest, randomWait, ROUNDS, saveBest, summarize } from './logic'

/** 阶段：待开始 / 等待变色 / 可点击 / 单轮结果 / 犯规 / 全部完成 */
type Phase = 'idle' | 'waiting' | 'go' | 'result' | 'foul' | 'done'

/** 当前阶段 */
const phase = ref<Phase>('idle')
/** 已完成的有效成绩（毫秒） */
const times = ref<number[]>([])
/** 本轮反应时间（毫秒） */
const current = ref(0)
/** 历史最好成绩 */
const best = ref<number | null>(loadBest())
/** 本组是否刷新了历史最好 */
const newBest = ref(false)

/** 变色时刻（performance.now），在变色后的那一帧里记录 */
let goAt = 0
/** 等待计时器 */
let waitTimer: ReturnType<typeof setTimeout> | undefined
/** 变色帧回调句柄 */
let rafId = 0

/** 本组统计 */
const stats = computed(() => summarize(times.value))
/** 评语 */
const grade = computed(() => gradeFor(stats.value.average))
/** 当前是第几轮（从 1 起） */
const round = computed(() => Math.min(ROUNDS, times.value.length + 1))
/** 触摸区的文案 */
const label = computed(() => {
  switch (phase.value) {
    case 'idle':
      return '点一下开始'
    case 'waiting':
      return '等绿色，别点'
    case 'go':
      return '现在点！'
    case 'result':
      return `${current.value} ms`
    case 'foul':
      return '抢跑了！'
    default:
      return '完成'
  }
})
/** 触摸区下方的小字 */
const sub = computed(() => {
  if (phase.value === 'idle') return `共 ${ROUNDS} 轮，取平均`
  if (phase.value === 'result') return isSuspicious(current.value) ? '快得有点离谱，可能是手滑，点一下继续' : '点一下继续'
  if (phase.value === 'foul') return '这一轮不算，点一下重来'
  if (phase.value === 'waiting' || phase.value === 'go') return `第 ${round.value} / ${ROUNDS} 轮`
  return ''
})

/** 清掉所有计时器与帧回调 */
function clearTimers(): void {
  clearTimeout(waitTimer)
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
}

/** 开始一轮：随机等待后变色，变色那一帧里才记起点 */
function startRound(): void {
  phase.value = 'waiting'
  goAt = 0
  waitTimer = setTimeout(() => {
    phase.value = 'go'
    // 等浏览器真正绘制出绿色的那一帧再起表
    rafId = requestAnimationFrame(() => {
      goAt = performance.now()
      rafId = 0
    })
  }, randomWait())
}

/** 全部轮次完成：更新历史最好 */
function finish(): void {
  phase.value = 'done'
  const b = stats.value.best
  if (isNewBest(b, best.value)) {
    best.value = b
    newBest.value = true
    saveBest(b)
  }
}

/** 重新开始一组 */
function restart(): void {
  clearTimers()
  times.value = []
  newBest.value = false
  startRound()
}

/** 触摸区按下：pointerdown 比 click 少一个延迟，更准 */
function onPress(): void {
  const now = performance.now()
  switch (phase.value) {
    case 'idle':
      restart()
      break
    case 'foul':
      startRound()
      break
    case 'waiting':
      clearTimers()
      phase.value = 'foul'
      break
    case 'go':
      // 变色那一帧还没绘制完（极端情况）就忽略这次点击
      if (!goAt) return
      current.value = Math.max(0, Math.round(now - goAt))
      times.value.push(current.value)
      goAt = 0
      phase.value = 'result'
      break
    case 'result':
      if (times.value.length >= ROUNDS) finish()
      else startRound()
      break
    default:
      break
  }
}

onBeforeUnmount(clearTimers)
</script>

<template>
  <div class="tool-page">
    <div
      class="rt-pad"
      :class="`rt-pad--${phase}`"
      role="button"
      tabindex="0"
      @pointerdown.prevent="phase !== 'done' && onPress()"
    >
      <b class="rt-pad__main">{{ label }}</b>
      <span class="rt-pad__sub">{{ sub }}</span>
    </div>

    <div v-if="phase === 'done'" class="tool-card">
      <h3 class="tool-card__title">本组成绩</h3>
      <p class="rt-avg">平均 {{ stats.average }} ms</p>
      <p class="rt-grade">{{ grade.title }}：{{ grade.comment }}</p>
      <p class="tool-hint">最好 {{ stats.best }} ms，最慢 {{ stats.worst }} ms<span v-if="newBest">，刷新了历史最好！</span></p>
      <van-button type="primary" block round @click="restart">再来一组</van-button>
    </div>

    <div v-if="times.length && phase !== 'done'" class="tool-card">
      <h3 class="tool-card__title">已完成</h3>
      <div class="rt-times">
        <span v-for="(t, i) in times" :key="i" class="rt-times__item">{{ t }} ms</span>
      </div>
    </div>

    <p class="tool-hint">
      历史最好：{{ best === null ? '暂无' : `${best} ms` }}。结果包含屏幕刷新和触控采样延迟，只适合和自己比，不同手机之间不可比。
    </p>
  </div>
</template>

<style lang="scss" scoped>
/* 触摸区：整块可点，禁止长按选字与双击缩放；颜色是状态色，不随主题变 */
.rt-pad {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $space-2;
  min-height: 280px;
  border-radius: var(--tool-card-radius);
  color: #fff;
  background: #3b6cf6;
  user-select: none;
  -webkit-user-select: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;

  &--waiting {
    background: #ee0a24;
  }

  &--go {
    background: #07c160;
  }

  &--foul {
    background: #ff976a;
  }

  &--done {
    background: #7d7e80;
  }

  &__main {
    font-size: 32px;
  }

  &__sub {
    font-size: 14px;
    opacity: 0.85;
  }
}

/* 平均值 */
.rt-avg {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  color: var(--c-text);
}

/* 评语 */
.rt-grade {
  margin: $space-2 0;
  color: var(--c-text);
}

/* 每轮成绩 */
.rt-times {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;

  &__item {
    padding: 2px $space-2;
    border-radius: 8px;
    background: var(--c-surface-active);
    color: var(--c-text);
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
}
</style>
