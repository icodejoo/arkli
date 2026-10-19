<script setup lang="ts">
// 2048：滑动手势或方向按钮移动，记录分数与最高分
import BottomActions from '@/shared/BottomActions.vue'
import { computed, ref } from 'vue'
import { canMove, hasWon, loadBest, newGame, saveBest, step, swipeDir, type Board, type Dir } from './logic'

/** 方向按钮配置 */
const PAD: readonly { dir: Dir; icon: string }[] = [
  { dir: 'up', icon: 'arrow-up' },
  { dir: 'left', icon: 'arrow-left' },
  { dir: 'down', icon: 'arrow-down' },
  { dir: 'right', icon: 'arrow' },
]

/** 棋盘 */
const board = ref<Board>(newGame())
/** 当前分数 */
const score = ref(0)
/** 最高分 */
const best = ref(loadBest())
/** 是否已提示过胜利（之后可继续玩） */
const won = ref(false)
/** 是否结束 */
const over = computed(() => !canMove(board.value))
/** 手指按下坐标 */
let startPt: { x: number; y: number } | null = null

/** 沿方向走一步，并更新分数与最高分 */
function go(dir: Dir): void {
  if (over.value) return
  const r = step(board.value, dir)
  if (!r.moved) return
  board.value = r.board
  score.value += r.gained
  if (score.value > best.value) {
    best.value = score.value
    saveBest(best.value)
  }
  if (!won.value && hasWon(r.board)) won.value = true
}

/** 重新开局 */
function restart(): void {
  board.value = newGame()
  score.value = 0
  won.value = false
}

/** 记录滑动起点 */
function onStart(e: TouchEvent): void {
  const t = e.touches[0]
  startPt = t ? { x: t.clientX, y: t.clientY } : null
}

/** 滑动结束后判定方向 */
function onEnd(e: TouchEvent): void {
  const t = e.changedTouches[0]
  if (!startPt || !t) return
  const d = swipeDir(t.clientX - startPt.x, t.clientY - startPt.y)
  startPt = null
  if (d) go(d)
}
</script>

<template>
  <div class="tool-page">
    <div class="g-head">
      <div class="g-score"><span>分数</span><b>{{ score }}</b></div>
      <div class="g-score"><span>最高分</span><b>{{ best }}</b></div>
    </div>

    <div class="g-board" @touchstart.passive="onStart" @touchend="onEnd">
      <div v-for="(v, i) in board" :key="i" class="g-cell" :class="v ? `g-cell--${Math.min(v, 4096)}` : ''">{{ v || '' }}</div>
      <div v-if="over" class="g-mask">游戏结束</div>
    </div>

    <p v-if="won && !over" class="tool-hint">合成了 2048，太强了！可以继续冲更高。</p>

    <div class="g-pad">
      <van-button v-for="p in PAD" :key="p.dir" :class="`g-pad__${p.dir}`" round plain @click="go(p.dir)">
        <van-icon :name="p.icon" />
      </van-button>
    </div>

    <bottom-actions main main-text="重新开始" main-type="warning" @main="restart" />
  </div>
</template>

<style lang="scss" scoped>
/* 分数条 */
.g-head {
  display: flex;
  gap: $space-2;
  margin-bottom: $space-2;
}

/* 单个分数块 */
.g-score {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-2;
  border-radius: 8px;
  background: var(--c-surface);
  color: var(--c-text);

  span {
    font-size: 12px;
    color: var(--c-text-muted);
  }

  b {
    font-size: 20px;
  }
}

/* 棋盘（方块配色是游戏固定色，不随主题变） */
.g-board {
  position: relative;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  padding: 8px;
  border-radius: 10px;
  background: #bbada0;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

/* 方块 */
.g-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  border-radius: 6px;
  background: #cdc1b4;
  color: #776e65;
  font-size: 24px;
  font-weight: 700;

  &--2 { background: #eee4da; }
  &--4 { background: #ede0c8; }
  &--8 { background: #f2b179; color: #fff; }
  &--16 { background: #f59563; color: #fff; }
  &--32 { background: #f67c5f; color: #fff; }
  &--64 { background: #f65e3b; color: #fff; }
  &--128 { background: #edcf72; color: #fff; font-size: 20px; }
  &--256 { background: #edcc61; color: #fff; font-size: 20px; }
  &--512 { background: #edc850; color: #fff; font-size: 20px; }
  &--1024 { background: #edc53f; color: #fff; font-size: 17px; }
  &--2048 { background: #edc22e; color: #fff; font-size: 17px; }
  &--4096 { background: #3c3a32; color: #fff; font-size: 17px; }
}

/* 结束遮罩 */
.g-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: rgb(238 228 218 / 0.75);
  color: #776e65;
  font-size: 28px;
  font-weight: 700;
}

/* 方向键：倒 T 形 */
.g-pad {
  display: grid;
  grid-template-columns: repeat(3, 56px);
  grid-template-areas: '. up .' 'left down right';
  justify-content: center;
  gap: $space-2;
  margin-top: $space-4;

  &__up { grid-area: up; }
  &__left { grid-area: left; }
  &__down { grid-area: down; }
  &__right { grid-area: right; }
}
</style>
