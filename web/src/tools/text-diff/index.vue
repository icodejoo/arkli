<script setup lang="ts">
// 文本对比：两段文字按行或按字符对比，删除 / 新增高亮并统计
import { computed, ref } from 'vue'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { diffText, type DiffMode } from './logic'

/** 本工具的持久缓存 */
const store = createToolStorage('text-diff')
/** 对比模式 */
const mode = usePersistedRef<DiffMode>(store, 'mode', 'line', (v) => v === 'line' || v === 'char')
/** 原文 */
const oldText = ref('')
/** 新文 */
const newText = ref('')

/** 对比结果；两边都空时不算 */
const result = computed(() => (oldText.value === '' && newText.value === '' ? null : diffText(oldText.value, newText.value, mode.value)))
/** 完全相同 */
const same = computed(() => !!result.value && result.value.ok && result.value.stats.del === 0 && result.value.stats.add === 0)
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="mode" type="card">
      <van-tab title="按行" name="line" />
      <van-tab title="按字符" name="char" />
    </van-tabs>

    <tool-group title="原文">
      <van-field v-model="oldText" type="textarea" rows="4" autosize clearable placeholder="粘贴原文" />
    </tool-group>
    <tool-group title="新文">
      <van-field v-model="newText" type="textarea" rows="4" autosize clearable placeholder="粘贴新文" />
    </tool-group>

    <p v-if="result && !result.ok" class="tool-hint diff-error">{{ result.error }}</p>

    <tool-group v-if="result && result.ok" :title="`结果：删除 ${result.stats.del} ${mode === 'line' ? '行' : '字'}，新增 ${result.stats.add} ${mode === 'line' ? '行' : '字'}`">
      <p v-if="same" class="tool-hint">两段文字完全相同。</p>
      <div v-if="mode === 'line'" class="diff-lines">
        <div v-for="(p, i) in result.parts" :key="i" class="diff-line" :class="`diff-${p.type}`">
          <span class="diff-mark">{{ p.type === 'del' ? '-' : p.type === 'add' ? '+' : ' ' }}</span>
          <span class="diff-text">{{ p.text || ' ' }}</span>
        </div>
      </div>
      <div v-else class="diff-chars">
        <span v-for="(p, i) in result.parts" :key="i" :class="`diff-${p.type}`">{{ p.text }}</span>
      </div>
    </tool-group>
  </div>
</template>

<style lang="scss" scoped>
.diff-error {
  color: var(--c-error);
}
.diff-lines,
.diff-chars {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
}
.diff-chars {
  white-space: pre-wrap;
  word-break: break-all;
}
.diff-line {
  display: flex;
  gap: 6px;
}
.diff-mark {
  flex: none;
  width: 1ch;
  color: var(--c-text-muted);
}
.diff-text {
  white-space: pre-wrap;
  word-break: break-all;
}
.diff-del {
  color: #b42318;
  background: rgba(240, 68, 56, 0.16);
}
.diff-add {
  color: #067647;
  background: rgba(18, 183, 106, 0.18);
}
.diff-chars .diff-del {
  text-decoration: line-through;
}
</style>
