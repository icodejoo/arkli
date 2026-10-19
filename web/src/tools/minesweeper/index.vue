<script setup lang="ts">
// 扫雷：点开格子，长按插旗；首次点击必不踩雷
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { createLongPress } from '@/views/useLongPress'
import { createGame, formatTime, LEVELS, minesLeft, reveal, toggleFlag, type Game, type Level } from './logic'

/** 计时刷新间隔（毫秒） */
const TICK_MS = 1000
/** 数字配色，下标为周围雷数 */
const NUM_COLORS = ['', '#1e6fff', '#2e9e4f', '#e03131', '#1c3d99', '#a61e4d', '#0c8599', '#212529', '#868e96']

/** 当前难度 */
const level = ref<Level>(LEVELS[0])
/** 对局 */
const game = ref<Game>(createGame(level.value))
/** 已用秒数 */
const seconds = ref(0)
/** 点按改为插旗（无长按条件时的备选） */
const flagMode = ref(false)
/** 计时器句柄 */
let timer: ReturnType<typeof setInterval> | undefined

/** 长按插旗 */
const press = createLongPress((key) => {
  game.value = toggleFlag(game.value, Number(key))
  vibrate()
})

/** 顶部状态表情 */
const face = computed(() => ({ ready: '🙂', playing: '🙂', won: '😎', lost: '😵' })[game.value.status])
/** 雷数显示 */
const leftText = computed(() => String(minesLeft(game.value)))
/** 网格列样式 */
const gridStyle = computed(() => ({ gridTemplateColumns: `repeat(${game.value.cols}, 1fr)` }))

/** 轻震一下，不支持则忽略 */
function vibrate(): void {
  try {
    navigator.vibrate?.(20)
  } catch {
    // 忽略
  }
}

/** 停止计时 */
function stopTimer(): void {
  clearInterval(timer)
  timer = undefined
}

/** 点按格子：吞掉长按后的 click，其余按模式翻开或插旗 */
function onTap(i: number): void {
  if (press.consumeClick()) return
  game.value = flagMode.value ? toggleFlag(game.value, i) : reveal(game.value, i)
}

/** 开新局 */
function restart(): void {
  stopTimer()
  seconds.value = 0
  game.value = createGame(level.value)
}

/** 状态进入进行中时开表，结束时停表 */
watch(
  () => game.value.status,
  (s) => {
    if (s === 'playing' && !timer) timer = setInterval(() => seconds.value++, TICK_MS)
    if (s === 'won' || s === 'lost') stopTimer()
  },
)
watch(level, restart)
onBeforeUnmount(stopTimer)
</script>

<template>
  <div class="tool-page">
    <van-radio-group v-model="level" direction="horizontal">
      <van-radio v-for="l in LEVELS" :key="l.id" :name="l">{{ l.name }}</van-radio>
    </van-radio-group>

    <div class="ms-head">
      <span class="ms-lcd">💣 {{ leftText }}</span>
      <button class="ms-face" type="button" @click="restart">{{ face }}</button>
      <span class="ms-lcd">⏱ {{ formatTime(seconds) }}</span>
    </div>

    <div class="ms-grid" :style="gridStyle">
      <button
        v-for="(c, i) in game.cells"
        :key="i"
        type="button"
        class="ms-cell"
        :class="{ 'ms-cell--open': c.state === 'open', 'ms-cell--boom': game.boom === i }"
        :style="c.state === 'open' && !c.mine ? { color: NUM_COLORS[c.adj] } : undefined"
        @touchstart.passive="press.start($event, String(i))"
        @touchmove.passive="press.move"
        @touchend="press.end"
        @touchcancel="press.end"
        @contextmenu.prevent
        @click="onTap(i)"
      >
        <template v-if="c.state === 'flag'">🚩</template>
        <template v-else-if="c.state === 'open'">{{ c.mine ? '💣' : c.adj || '' }}</template>
      </button>
    </div>

    <p v-if="game.status === 'won'" class="tool-hint">排雷成功，用时 {{ seconds }} 秒！</p>
    <p v-else-if="game.status === 'lost'" class="tool-hint">踩雷了，点上面的表情重新来。</p>
    <p v-else class="tool-hint">点开格子，长按插旗。首次点击一定安全。</p>

    <van-cell title="点按改为插旗" center><template #value><van-switch v-model="flagMode" size="22" /></template></van-cell>

    <bottom-actions main main-text="重新开始" main-type="warning" @main="restart" />
  </div>
</template>

<style lang="scss" scoped>
/* 顶部信息条 */
.ms-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: $space-2 0;
}

/* 数字显示 */
.ms-lcd {
  min-width: 80px;
  color: var(--c-text);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

/* 表情按钮 */
.ms-face {
  border: 0;
  background: transparent;
  font-size: 28px;
}

/* 网格 */
.ms-grid {
  display: grid;
  gap: 2px;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: manipulation;
}

/* 格子（翻开前后配色用固定灰阶，亮暗主题都清楚） */
.ms-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: #9aa5b1;
  font-size: 14px;
  font-weight: 700;
  -webkit-tap-highlight-color: transparent;

  &--open {
    background: #e9ecef;
  }

  &--boom {
    background: #ffa8a8;
  }
}
</style>
