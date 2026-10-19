<script setup lang="ts">
// 随机点名：粘贴名单，抽 1~N 人，可选不重复，带滚动动画
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { showToast } from 'vant'
import { prefersReducedMotion } from '@/shared/motion'
import { drawNames, loadNames, MAX_PICK, parseNames, saveNames } from './logic'

/** 滚动动画总时长（毫秒） */
const ANIM_MS = 1000
/** 滚动时名字刷新间隔（毫秒） */
const TICK_MS = 70

/** 名单原文 */
const text = ref(loadNames())
/** 抽几人 */
const count = ref(1)
/** 不重复模式 */
const noRepeat = ref(false)
/** 已抽过的人 */
const used = ref<string[]>([])
/** 当前展示（滚动中为随机名字，停下为结果） */
const shown = ref<string[]>([])
/** 是否正在滚动 */
const rolling = ref(false)
/** 滚动定时器 */
let ticker: ReturnType<typeof setInterval> | undefined
/** 收尾定时器 */
let stopper: ReturnType<typeof setTimeout> | undefined

/** 解析后的名单 */
const names = computed(() => parseNames(text.value))
/** 还剩多少人没抽（不重复模式） */
const left = computed(() => names.value.filter((n) => !used.value.includes(n)).length)
/** 抽取人数的上限 */
const maxCount = computed(() => Math.max(1, Math.min(MAX_PICK, names.value.length)))

/** 名单变化落盘，并清掉已抽记录 */
watch(text, (v) => {
  saveNames(v)
  used.value = []
})
/** 人数不能超过名单 */
watch(maxCount, (m) => {
  if (count.value > m) count.value = m
})

/** 清掉动画定时器 */
function clearTimers(): void {
  clearInterval(ticker)
  clearTimeout(stopper)
}

/** 重置已抽记录 */
function resetUsed(): void {
  used.value = []
  shown.value = []
}

/** 开抽：结果先定好，动画只做表演 */
function roll(): void {
  if (rolling.value) return
  if (!names.value.length) {
    showToast('先输入名单')
    return
  }
  const r = drawNames(names.value, count.value, noRepeat.value, used.value)
  if (!r.picked.length) {
    showToast('名单已抽完，点“重置”再来')
    return
  }
  const finish = (): void => {
    shown.value = r.picked
    used.value = r.used
    rolling.value = false
    if (r.exhausted && noRepeat.value) showToast('名单抽完了，点“重置”可重新开始')
  }
  if (prefersReducedMotion()) {
    finish()
    return
  }
  rolling.value = true
  const fake = (): string[] => drawNames(names.value, r.picked.length, false).picked
  shown.value = fake()
  ticker = setInterval(() => (shown.value = fake()), TICK_MS)
  stopper = setTimeout(() => {
    clearTimers()
    finish()
  }, ANIM_MS)
}

onBeforeUnmount(clearTimers)
</script>

<template>
  <div class="tool-page">
    <div class="rc-stage" :class="{ 'rc-stage--rolling': rolling }">
      <span v-if="!shown.length" class="rc-empty">点“开抽”点名</span>
      <b v-for="(n, i) in shown" :key="`${i}${n}`" class="rc-name">{{ n }}</b>
    </div>

    <tool-group title="名单">
      <van-field v-model="text" type="textarea" rows="5" autosize placeholder="每行一个名字，可直接粘贴" />
      <p class="tool-hint">共 {{ names.length }} 人（重复姓名只算一次）<span v-if="noRepeat">，还剩 {{ left }} 人没抽</span></p>
    </tool-group>

    <tool-group title="设置">
      <van-cell title="一次抽几人" center>
        <template #value><van-stepper v-model="count" :min="1" :max="maxCount" integer /></template>
      </van-cell>
      <van-cell title="不重复（抽过的不再抽）" center>
        <template #value><van-switch v-model="noRepeat" size="22" @change="resetUsed" /></template>
      </van-cell>
      <van-button v-if="noRepeat" size="small" plain @click="resetUsed">重置已抽记录</van-button>
    </tool-group>

    <bottom-actions main main-text="开抽" :disabled="{ main: rolling }" @main="roll" />
  </div>
</template>

<style lang="scss" scoped>
/* 结果舞台 */
.rc-stage {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: $space-2 $space-4;
  min-height: 140px;
  padding: $space-4;
  border-radius: var(--tool-card-radius);
  background: var(--c-surface);
  color: var(--c-text);

  &--rolling .rc-name {
    opacity: 0.6;
  }
}

/* 占位提示 */
.rc-empty {
  color: var(--c-text-muted);
}

/* 名字 */
.rc-name {
  font-size: 36px;
  line-height: 1.3;
}
</style>
