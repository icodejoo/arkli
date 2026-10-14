<script setup lang="ts">
// 花样文字：输入文字，同时列出上标、下标、小型大写、全角、圈号等样式，点一下复制
import { computed, ref } from 'vue'
import { showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { convertAll } from './logic'

/** 输入文本 */
const text = ref('Hello 2025')

/** 所有花样的转换结果 */
const results = computed(() => convertAll(text.value))

/** 复制某一条结果 */
async function copy(s: string): Promise<void> {
  if (!s) {
    showToast('先输入点内容')
    return
  }
  showToast((await copyText(s)) ? '已复制' : '复制失败，请手动长按选择')
}
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-field v-model="text" type="textarea" rows="2" autosize placeholder="输入英文或数字" clearable />
      <p class="tool-hint">英文、数字有效；中文等没有对应样式的字符会原样保留。</p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">点一条即可复制</h3>
      <div v-for="r in results" :key="r.id" class="ft-row" role="button" @click="copy(r.text)">
        <span class="ft-row__label">{{ r.label }}</span>
        <span class="ft-row__text">{{ r.text || '—' }}</span>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 一行结果 */
.ft-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: $space-2 0;
  border-bottom: 1px solid var(--c-border);

  &:last-child {
    border-bottom: 0;
  }

  &:active {
    background: var(--c-surface-active);
  }
}

/* 样式名 */
.ft-row__label {
  font-size: 12px;
  color: var(--c-text-muted);
}

/* 转换后的文字 */
.ft-row__text {
  font-size: 18px;
  color: var(--c-text);
  word-break: break-all;
}
</style>
