<script setup lang="ts">
// 处理结果列表：缩略图 + 文件名 + 尺寸/体积 + 附加说明
import { showImagePreview } from 'vant'
import { formatBytes } from './image-calc'
import { previewBlob } from './image-io'
import type { ResultItem } from './useImageResults'

const props = defineProps<{
  /** 处理结果 */
  results: ResultItem[]
}>()

/** 预览第 i 张：宿主内走原生全屏（缩放、超长图局部高清），浏览器里回退 vant 预览 */
async function preview(i: number): Promise<void> {
  const r = props.results[i]
  try {
    if (await previewBlob(r.blob, r.name)) return
  } catch {
    // 原生预览失败时回退
  }
  showImagePreview({ images: props.results.map((x) => x.url), startPosition: i, closeable: true })
}
</script>

<template>
  <ul class="results">
    <li v-for="(r, i) in results" :key="r.id" class="result" @click="preview(i)">
      <img class="result__img" :src="r.url" :alt="r.name" />
      <div class="result__info">
        <div class="result__name">{{ r.name }}</div>
        <div class="result__meta">{{ r.width }}×{{ r.height }} · {{ formatBytes(r.blob.size) }}</div>
        <div v-if="r.note" class="result__note">{{ r.note }}</div>
      </div>
    </li>
  </ul>
</template>

<style lang="scss" scoped>
.results {
  margin: 0;
  padding: 0;
  list-style: none;

  /* 有内容时与后面的按钮留距 */
  &:not(:empty) {
    margin-bottom: $space-3;
  }
}

.result {
  display: flex;
  align-items: center;
  gap: $space-3;
  padding: $space-2 0;
  border-bottom: 1px solid var(--c-border);
  cursor: pointer;

  &:last-child {
    border-bottom: 0;
  }
}

.result__img {
  flex: none;
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--c-surface-active);
}

.result__info {
  flex: 1;
  min-width: 0;
}

.result__name {
  overflow: hidden;
  font-size: 14px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.result__meta {
  font-size: 12px;
  color: var(--c-text-muted);
}

/* 体积变化说明，主色强调 */
.result__note {
  font-size: 13px;
  font-weight: 500;
  color: var(--c-ok);
}
</style>
