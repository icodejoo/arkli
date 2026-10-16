<script setup lang="ts">
// 十六型人格倾向测试：一次一题的五级量表，答完给出类型、各维度倾向，可复制结果文字
import BottomActions from '@/shared/BottomActions.vue'
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { DIM_INFO, QUESTIONS, SCALE } from './data'
import { computeResult, formatResultText } from './logic'

/** 总题数 */
const TOTAL = QUESTIONS.length

/** 已选答案，下标对应题号，0 为未答 */
const answers = ref<number[]>(Array(TOTAL).fill(0))
/** 当前题号 */
const current = ref(0)
/** 是否已提交看结果 */
const finished = ref(false)

/** 当前题 */
const question = computed(() => QUESTIONS[current.value])
/** 进度百分比 */
const percent = computed(() => Math.round((current.value / TOTAL) * 100))
/** 计算结果，未答完为 null */
const result = computed(() => (finished.value ? computeResult(answers.value) : null))

/** 选择答案，答完最后一题直接出结果，否则进入下一题 */
function choose(value: number): void {
  answers.value[current.value] = value
  if (current.value < TOTAL - 1) current.value++
  else finished.value = true
}

/** 前进：当前题已答则进入下一题，最后一题则提交看结果；没答不动 */
function next(): void {
  if (!answers.value[current.value]) return
  if (current.value < TOTAL - 1) current.value++
  else finished.value = true
}

/** 回到上一题 */
function prev(): void {
  if (current.value > 0) current.value--
}

/** 重新开始 */
function restart(): void {
  answers.value = Array(TOTAL).fill(0)
  current.value = 0
  finished.value = false
}

/** 复制结果文字 */
async function copyResult(): Promise<void> {
  if (!result.value) return
  if (await copyText(formatResultText(result.value))) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}
</script>

<template>
  <div class="tool-page">
    <template v-if="!result">
      <tool-group>
        <van-progress :percentage="percent" :show-pivot="false" />
        <p class="tool-hint">第 {{ current + 1 }} / {{ TOTAL }} 题 · {{ DIM_INFO[question.dim].title }}</p>
        <p class="pt-q">{{ question.text }}</p>
        <div class="pt-options">
          <van-button
            v-for="s in SCALE"
            :key="s.value"
            block
            :type="answers[current] === s.value ? 'primary' : 'default'"
            @click="choose(s.value)"
          >
            {{ s.label }}
          </van-button>
        </div>
      </tool-group>
      <p class="tool-hint">仅供娱乐，不构成心理评估。按第一感觉答就好，没有对错。</p>
    </template>

    <template v-else>
      <tool-group :title="`${result.code} · ${result.type.name}`">
        <p>{{ result.type.desc }}</p>
        <p class="tool-hint">优点：{{ result.type.pros.join('；') }}</p>
        <p class="tool-hint">短板：{{ result.type.cons.join('；') }}</p>
      </tool-group>
      <tool-group title="四个维度的倾向">
        <div v-for="d in result.dims" :key="d.dim" class="pt-dim">
          <div class="pt-dim__row">
            <span>{{ DIM_INFO[d.dim].firstLabel }} {{ d.percentFirst }}%</span>
            <span>{{ DIM_INFO[d.dim].title }}</span>
            <span>{{ 100 - d.percentFirst }}% {{ DIM_INFO[d.dim].secondLabel }}</span>
          </div>
          <van-progress :percentage="d.percentFirst" :show-pivot="false" />
          <p v-if="d.tie" class="tool-hint">两端正好各半，结果按 {{ DIM_INFO[d.dim].second }} 端记，仅作参考。</p>
          <p v-else-if="d.borderline" class="tool-hint">这一项很接近中间，换个状态再测，结果可能不同。</p>
        </div>
      </tool-group>
      <p class="tool-hint">仅供娱乐，不构成心理评估。</p>
    </template>

    <!-- 底部动作栏：答题态主按钮下一题 / 提交（点选项会自动前进，这里用于回看上一题后继续），上一题放插槽；结果态主按钮重新测试，复制结果放插槽 -->
    <bottom-actions
      main
      :main-text="result ? '重新测试' : current === TOTAL - 1 ? '提交' : '下一题'"
      :disabled="{ main: !result && !answers[current] }"
      @main="result ? restart() : next()"
    >
      <van-action-bar-icon v-if="result" icon="description-o" text="复制结果" @click="copyResult" />
      <van-action-bar-icon v-else icon="arrow-left" text="上一题" :disabled="current === 0" @click="prev" />
    </bottom-actions>
  </div>
</template>

<style lang="scss" scoped>
/* 题干 */
.pt-q {
  margin: $space-3 0;
  font-size: 18px;
  line-height: 1.6;
}
/* 选项竖排，方便单手点 */
.pt-options {
  display: flex;
  flex-direction: column;
  gap: $space-2;
}
.pt-dim {
  margin-bottom: $space-3;
}
.pt-dim__row {
  display: flex;
  justify-content: space-between;
  margin-bottom: $space-1;
  font-size: 13px;
}
</style>
