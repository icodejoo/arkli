<script setup lang="ts">
// 九九乘法练习：四选一或输入答案，统计连对，错题回顾
import BottomActions from '@/shared/BottomActions.vue'
import { ref } from 'vue'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { accuracy, emptyStats, MAX_OPTIONS, makeQuestion, parseAnswer, recordAnswer, type Question } from './logic'

/** 答完后停留多久进入下一题（毫秒） */
const NEXT_DELAY_MS = 700

/** 乘数上限 */
const max = ref(9)
/** 作答方式 */
const mode = ref<'choice' | 'input'>('choice')
/** 乘数上限选项 */
const MAX_PICK_OPTIONS: CellOption[] = MAX_OPTIONS.map((m) => ({ value: m, label: `1~${m}` }))
/** 作答方式选项 */
const MODE_OPTIONS: CellOption[] = [
  { value: 'choice', label: '四选一' },
  { value: 'input', label: '输入答案' },
]
/** 当前题 */
const q = ref<Question>(makeQuestion(max.value))
/** 统计 */
const stats = ref(emptyStats())
/** 输入框内容 */
const text = ref('')
/** 本题已作答的反馈：null 未答 */
const feedback = ref<{ ok: boolean; given: number | null } | null>(null)
/** 是否显示错题 */
const showWrong = ref(false)
/** 下一题定时器 */
let timer: ReturnType<typeof setTimeout> | undefined

/** 提交一个答案 */
function submit(given: number | null): void {
  if (feedback.value) return
  stats.value = recordAnswer(stats.value, q.value, given)
  feedback.value = { ok: given === q.value.answer, given }
  timer = setTimeout(next, NEXT_DELAY_MS)
}

/** 提交输入框答案；空输入不算 */
function submitText(): void {
  const v = parseAnswer(text.value)
  if (v !== null) submit(v)
}

/** 出下一题 */
function next(): void {
  clearTimeout(timer)
  feedback.value = null
  text.value = ''
  q.value = makeQuestion(max.value, Math.random, q.value)
}

/** 清零重练 */
function reset(): void {
  stats.value = emptyStats()
  showWrong.value = false
  next()
}

/** 选了新范围：更新上限并清零 */
function onPickMax(v: number): void {
  max.value = v
  reset()
}
</script>

<template>
  <div class="tool-page">
    <tool-group title="设置">
      <cell-picker :model-value="max" title="乘数范围" :options="MAX_PICK_OPTIONS" @update:model-value="onPickMax($event as number)" />
      <cell-picker :model-value="mode" title="作答方式" :options="MODE_OPTIONS" @update:model-value="mode = $event as 'choice' | 'input'" />
    </tool-group>

    <div class="tt-card" :class="{ 'tt-card--ok': feedback?.ok, 'tt-card--bad': feedback && !feedback.ok }">
      <b class="tt-q">{{ q.a }} × {{ q.b }} = ?</b>
      <span v-if="feedback && !feedback.ok" class="tt-tip">正确答案是 {{ q.answer }}</span>
      <span v-else-if="feedback" class="tt-tip">答对了！</span>
    </div>

    <div v-if="mode === 'choice'" class="tt-opts">
      <van-button v-for="o in q.options" :key="o" size="large" plain type="primary" :disabled="!!feedback" @click="submit(o)">{{ o }}</van-button>
    </div>
    <van-field v-else v-model="text" type="digit" label="答案" placeholder="输入乘积" maxlength="4" :disabled="!!feedback" @keyup.enter="submitText">
      <template #button><van-button size="small" type="primary" :disabled="!!feedback" @click="submitText">提交</van-button></template>
    </van-field>

    <tool-group title="本轮成绩">
      <p class="tt-stat">答对 {{ stats.correct }} / {{ stats.total }}，正确率 {{ accuracy(stats) }}%</p>
      <p class="tt-stat">连对 {{ stats.streak }}，最长连对 {{ stats.bestStreak }}</p>
      <van-button v-if="stats.wrong.length" size="small" plain @click="showWrong = !showWrong">{{ showWrong ? '收起' : '查看' }}错题（{{ stats.wrong.length }}）</van-button>
      <van-cell-group v-if="showWrong" :border="false" class="tt-gap">
        <van-cell v-for="w in stats.wrong" :key="`${w.a}x${w.b}`" :title="`${w.a} × ${w.b} = ${w.answer}`" :value="`错 ${w.times} 次${w.given === null ? '' : `，答成 ${w.given}`}`" />
      </van-cell-group>
    </tool-group>

    <bottom-actions main main-text="重新练习" main-type="warning" @main="reset" />
  </div>
</template>

<style lang="scss" scoped>
/* 区块之间留白 */
.tt-gap {
  margin-top: $space-2;
}

/* 题目卡片 */
.tt-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-2;
  margin: $space-3 0;
  padding: $space-4;
  border-radius: var(--tool-card-radius);
  background: var(--c-surface);
  color: var(--c-text);

  &--ok {
    background: #e8f8ee;
    color: #0a7a3b;
  }

  &--bad {
    background: #fdecec;
    color: #c0392b;
  }
}

/* 题面 */
.tt-q {
  font-size: 40px;
  font-variant-numeric: tabular-nums;
}

/* 反馈提示 */
.tt-tip {
  font-size: 14px;
}

/* 选项 2x2 */
.tt-opts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: $space-2;
}

/* 统计行 */
.tt-stat {
  margin: 0 0 $space-2;
  color: var(--c-text);
}
</style>
