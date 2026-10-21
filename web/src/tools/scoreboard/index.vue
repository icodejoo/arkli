<script setup lang="ts">
// 记分牌：2~8 人加减分，自定义步长，撤销与重置，领先者高亮；状态自动存本地
import { computed, onUnmounted, ref, watch } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import { createAppAwake } from '../clock-screen/awake'
import { createToolStorage } from '@/shared/toolStorage'
import {
  addScore, loadState, MAX_NAME_LEN, MAX_PLAYERS, MAX_STEP, MIN_PLAYERS, normalizeStep, PLAYER_COLORS, rankPlayers,
  renamePlayer, resetScores, saveState, setPlayerCount, TOOL_NS, undo,
} from './logic'

/** 常用步长快捷项 */
const STEP_PRESETS = [1, 5, 10]

/** 持久缓存 */
const store = createToolStorage(TOOL_NS)
/** 整个记分牌状态，进页面时从本地恢复 */
const state = ref(loadState(store))

/** 「保持亮屏」开关，默认关，不落盘 */
const keepOn = ref(false)
/** 常亮控制器（原生优先，网页兜底） */
const awake = createAppAwake()

watch(keepOn, async (on) => {
  if (!on) return awake.release()
  if (!(await awake.acquire())) {
    keepOn.value = false
    showToast('常亮没打开，请在系统设置里调长息屏时间')
  }
})
onUnmounted(() => void awake.release())

// 任何变化都落盘（写失败时静默）
watch(state, (s) => saveState(s, store), { deep: true })

/** 排名信息，按玩家下标索引 */
const rankByIndex = computed(() => {
  const m: Record<number, ReturnType<typeof rankPlayers>[number]> = {}
  for (const r of rankPlayers(state.value.players)) m[r.index] = r
  return m
})
/** 玩家显示顺序：按名次排；同分保持原顺序 */
const order = computed(() => rankPlayers(state.value.players).map((r) => r.index))
/** 是否有可撤销的历史 */
const canUndo = computed(() => state.value.history.length > 0)

/** 玩家人数（双向绑定到步进器） */
const count = computed({
  get: () => state.value.players.length,
  set: (v: number) => {
    state.value = setPlayerCount(state.value, v)
  },
})

/** 步长（双向绑定，输入时规范化） */
const step = computed({
  get: () => state.value.step,
  set: (v: number | string) => {
    state.value = { ...state.value, step: normalizeStep(v) }
  },
})

/** 加减分：direction 为 1 加、-1 减 */
function change(index: number, direction: 1 | -1): void {
  state.value = addScore(state.value, index, direction * state.value.step)
}

/** 改名 */
function rename(index: number, name: string): void {
  state.value = renamePlayer(state.value, index, name)
}

/** 撤销一步 */
function doUndo(): void {
  state.value = undo(state.value)
}

/** 重置分数，先确认，免得手滑 */
async function doReset(): Promise<void> {
  try {
    await showConfirmDialog({ title: '重置分数', message: '所有人的分数和操作历史都会清零。' })
    state.value = resetScores(state.value)
  } catch {
    // 用户取消
  }
}
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <van-cell-group :border="false">
        <van-cell title="人数" center>
          <template #value>
            <van-stepper v-model="count" :min="MIN_PLAYERS" :max="MAX_PLAYERS" integer />
          </template>
        </van-cell>
      </van-cell-group>
      <van-cell-group :border="false">
        <van-cell title="保持亮屏" center>
          <template #right-icon><van-switch v-model="keepOn" size="20" /></template>
        </van-cell>
      </van-cell-group>
      <h3 class="tool-group__title sb-gap">每次加减</h3>
      <div class="sb-step">
        <van-button v-for="n in STEP_PRESETS" :key="n" size="small" :type="state.step === n ? 'primary' : 'default'" @click="step = n">{{ n }}</van-button>
        <van-stepper v-model="step" :min="1" :max="MAX_STEP" integer input-width="56px" />
      </div>
    </tool-group>

    <div class="sb-list">
      <tool-group v-for="i in order" :key="i" inset class="sb-row" :class="{ 'sb-row--lead': rankByIndex[i]?.leading }" :style="{ '--sb-color': PLAYER_COLORS[i] }">
        <span class="sb-rank">{{ rankByIndex[i]?.rank }}</span>
        <input
          class="sb-name"
          :value="state.players[i].name"
          :maxlength="MAX_NAME_LEN"
          autocomplete="off"
          aria-label="玩家名字"
          @change="rename(i, ($event.target as HTMLInputElement).value)"
        />
        <van-button class="sb-btn" round icon="minus" aria-label="减分" @click="change(i, -1)" />
        <span class="sb-score">{{ state.players[i].score }}</span>
        <van-button class="sb-btn" round type="primary" icon="plus" aria-label="加分" @click="change(i, 1)" />
      </tool-group>
    </div>

    <div class="sb-actions">
      <van-button plain block :disabled="!canUndo" @click="doUndo">撤销（{{ state.history.length }}）</van-button>
      <van-button plain block type="danger" @click="doReset">重置</van-button>
    </div>
    <p class="tool-hint">分数自动保存在本机，下次打开还在。</p>
  </div>
</template>

<style lang="scss" scoped>
/* 卡片内小标题与上方留距 */
.sb-gap {
  margin-top: $space-3;
}

/* 步长一行 */
.sb-step {
  display: flex;
  align-items: center;
  gap: $space-2;
}

/* 玩家列表 */
.sb-list {
  display: flex;
  flex-direction: column;
  gap: $space-2;
}

/* 一位玩家：左边用玩家色做色条，领先者加粗边框 */
.sb-row {
  display: flex;
  align-items: center;
  gap: $space-2;
  padding: $space-3;
  border-left: 6px solid var(--sb-color);

  &--lead {
    outline: 2px solid var(--sb-color);
  }
}

/* 名次 */
.sb-rank {
  flex: 0 0 20px;
  text-align: center;
  color: var(--c-text-muted);
  font-size: 13px;
}

/* 名字输入框 */
.sb-name {
  flex: 1;
  min-width: 0;
  padding: 4px 0;
  border: 0;
  border-bottom: 1px dashed var(--c-border);
  background: transparent;
  color: var(--c-text);
  font-size: 16px;
}

/* 加减按钮 */
.sb-btn {
  flex: 0 0 44px;
  height: 44px;
  padding: 0;
}

/* 分数 */
.sb-score {
  flex: 0 0 64px;
  text-align: center;
  font-size: 28px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--c-text);
}

/* 撤销与重置并排 */
.sb-actions {
  display: flex;
  gap: $space-3;
}
</style>
