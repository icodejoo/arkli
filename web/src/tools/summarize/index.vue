<script setup lang="ts">
// 文章摘要：抽取式（TextRank），从原文里挑出最有代表性的几句，保持原文顺序
import BottomActions from '@/shared/BottomActions.vue'
import { ref } from 'vue'
import { showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { summarize, type SummaryResult } from './logic'

/** 默认摘要句数 */
const DEFAULT_N = 3
/** 最多可选句数 */
const MAX_N = 10

/** 原文 */
const text = ref('')
/** 摘要句数 */
const n = ref(DEFAULT_N)
/** 摘要结果 */
const result = ref<SummaryResult | null>(null)

/** 生成摘要 */
function run(): void {
  if (!text.value.trim()) {
    showToast('先贴一段文章')
    return
  }
  result.value = summarize(text.value, n.value)
}

/** 复制摘要 */
async function copy(): Promise<void> {
  if (!result.value) return
  showToast((await copyText(result.value.sentences.join(''))) ? '已复制' : '复制失败，请手动长按选择')
}
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <van-field v-model="text" type="textarea" rows="8" autosize placeholder="粘贴要概括的文章" />
      <van-cell title="摘要句数" center>
        <template #value><van-stepper v-model="n" :min="1" :max="MAX_N" integer /></template>
      </van-cell>
      <p class="tool-hint">抽取式，效果一般：只是挑原文里的句子，不会改写，也不懂语义。</p>
    </tool-group>

    <tool-group v-if="result" :title="`摘要（${result.sentences.length} / ${result.total} 句）`">
      <p v-if="!result.sentences.length" class="tool-hint">没分出句子，检查下原文有没有标点。</p>
      <p v-for="(s, i) in result.sentences" :key="i" class="sm-line">{{ s }}</p>
    </tool-group>

    <!-- 底部动作栏：复制摘要，主按钮生成摘要 -->
    <bottom-actions :actions="{ copy: { disabled: !result?.sentences.length } }" main main-text="生成摘要" @main="run" @copy="copy" />
  </div>
</template>

<style lang="scss" scoped>
/* 摘要中的一句 */
.sm-line {
  margin: 0 0 $space-2;
  line-height: 1.7;
  color: var(--c-text);
}
</style>
