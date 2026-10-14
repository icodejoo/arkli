<script setup lang="ts">
// 原生成品列表：只用缓存里的缩略图回显，点击走 native.image.preview，不把成品读回 WebView
import { showToast } from 'vant'
import { call } from '@/native/bridge'
import { formatBytes } from './image-calc'

/** 一条原生成品 */
export interface NativeRow {
  /** 列表 key */
  id: number
  /** 文件名 */
  name: string
  /** 缩略图同源地址 */
  thumbUrl: string
  /** 成品缓存相对路径，预览用 */
  path: string
  /** 宽 */
  width: number
  /** 高 */
  height: number
  /** 字节数 */
  size: number
  /** 附加说明，如“压缩前 1.2 MB，-62%” */
  note?: string
}

const props = defineProps<{
  /** 成品列表 */
  rows: NativeRow[]
}>()

/** 预览第 i 张；失败给 toast */
async function preview(i: number): Promise<void> {
  try {
    await call('native.image.preview', { paths: props.rows.map((r) => r.path), index: i })
  } catch (e) {
    const msg = (e as { message?: string }).message
    showToast(msg ? `预览失败：${msg}` : '预览失败')
  }
}
</script>

<template>
  <ul class="results">
    <li v-for="(r, i) in rows" :key="r.id" class="result" @click="preview(i)">
      <img class="result__img" :src="r.thumbUrl" :alt="r.name" />
      <div class="result__info">
        <div class="result__name">{{ r.name }}</div>
        <div class="result__meta">{{ r.width }}×{{ r.height }} · {{ formatBytes(r.size) }}</div>
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

/* 体积变化说明 */
.result__note {
  font-size: 13px;
  font-weight: 500;
  color: var(--c-ok);
}
</style>
