<script setup lang="ts">
// 拆分选词：把一段中文拆成词，点选想要的，拼起来复制
import BottomActions from '@/shared/BottomActions.vue'
import { computed, ref, watch } from 'vue'
import { showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { createSegmenter, joinSelected, selectAllWords, toggleIndex, tokenize } from './logic'

/** 本工具的持久缓存 */
const store = createToolStorage('word-split')
/** 输入文本 */
const text = ref('')
/** 选中的片段下标 */
const selected = ref<Set<number>>(new Set())
/** 是否用空格分隔选中的词 */
const spaced = usePersistedRef(store, 'spaced', false, (v) => typeof v === 'boolean')
/** 分词器（环境不支持时为 null，按字拆） */
const segmenter = createSegmenter()

/** 分词结果 */
const tokens = computed(() => tokenize(text.value, segmenter))
/** 选中词拼接后的文本 */
const output = computed(() => joinSelected(tokens.value, selected.value, spaced.value ? ' ' : ''))

// 文本变了，选中状态作废
watch(text, () => {
  selected.value = new Set()
})

/** 点选/取消一个词 */
function toggle(i: number): void {
  selected.value = toggleIndex(selected.value, i)
}

/** 全选所有词 */
function all(): void {
  selected.value = selectAllWords(tokens.value)
}

/** 复制拼接结果 */
async function copy(): Promise<void> {
  showToast((await copyText(output.value)) ? '已复制' : '复制失败，请手动长按选择')
}
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <van-field v-model="text" type="textarea" rows="4" autosize placeholder="粘贴或输入一段文字" />
      <p v-if="!segmenter" class="tool-hint">当前系统不支持智能分词，已改为按字拆分。</p>
    </tool-group>

    <tool-group v-if="tokens.length" title="点选要的词">
      <div class="ws-chips">
        <template v-for="(t, i) in tokens" :key="i">
          <span
            v-if="t.isWord"
            class="ws-chip"
            :class="{ 'ws-chip--on': selected.has(i) }"
            role="button"
            @click="toggle(i)"
            >{{ t.text }}</span
          >
          <span v-else class="ws-gap">{{ t.text }}</span>
        </template>
      </div>
      <div class="ws-actions">
        <van-button size="small" plain @click="all">全选</van-button>
        <van-button size="small" plain :disabled="!selected.size" @click="selected = new Set()">清除</van-button>
      </div>
      <van-cell-group :border="false">
        <van-cell title="词间加空格" center>
          <template #right-icon><van-switch v-model="spaced" size="20" /></template>
        </van-cell>
      </van-cell-group>
    </tool-group>

    <tool-group v-if="tokens.length" title="选中的内容">
      <p class="ws-out">{{ output || '还没选' }}</p>
    </tool-group>

    <!-- 底部动作栏：主操作就是复制选中的内容 -->
    <bottom-actions main main-text="复制" :disabled="{ main: !output }" @main="copy" />
  </div>
</template>

<style lang="scss" scoped>
/* 词块容器 */
.ws-chips {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

/* 一个可点的词 */
.ws-chip {
  padding: 4px 10px;
  border-radius: 14px;
  background: var(--c-surface-active);
  border: 1px solid transparent;
  color: var(--c-text);
  font-size: 16px;
  user-select: none;

  &--on {
    background: var(--c-primary);
    color: var(--c-on-primary);
  }
}

/* 标点、空白，不可点 */
.ws-gap {
  align-self: center;
  color: var(--c-text-muted);
  white-space: pre;
}

/* 操作行 */
.ws-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-3;
  margin-top: $space-3;
}

/* 拼接结果 */
.ws-out {
  margin: 0 0 $space-3;
  min-height: 24px;
  word-break: break-all;
  color: var(--c-text);
}
</style>
