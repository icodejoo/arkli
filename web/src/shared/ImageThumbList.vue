<script setup lang="ts">
// 已选图片列表：缩略图 + 名称/尺寸/体积；可选排序与删除
import { formatBytes } from './image-calc'
import type { PickedImage } from './image-io'

defineProps<{
  /** 已选图片 */
  images: PickedImage[]
  /** 是否显示上移/下移按钮 */
  sortable?: boolean
}>()

const emit = defineEmits<{
  /** 删除第 i 张 */
  (e: 'remove', index: number): void
  /** 把第 i 张移动 delta 位（-1 上移，1 下移） */
  (e: 'move', index: number, delta: number): void
}>()
</script>

<template>
  <ul class="thumbs">
    <li v-for="(img, i) in images" :key="img.url" class="thumb">
      <img class="thumb__img" :src="img.url" :alt="img.name" />
      <div class="thumb__info">
        <div class="thumb__name">{{ img.name }}</div>
        <div class="thumb__meta">{{ img.width }}×{{ img.height }} · {{ formatBytes(img.size) }}</div>
      </div>
      <div class="thumb__ops">
        <template v-if="sortable">
          <van-button size="mini" plain :disabled="i === 0" aria-label="上移" @click="emit('move', i, -1)">↑</van-button>
          <van-button size="mini" plain :disabled="i === images.length - 1" aria-label="下移" @click="emit('move', i, 1)">↓</van-button>
        </template>
        <van-button size="mini" plain type="danger" aria-label="删除" @click="emit('remove', i)">删除</van-button>
      </div>
    </li>
  </ul>
</template>

<style lang="scss" scoped>
.thumbs {
  margin: 0;
  padding: 0;
  list-style: none;

  /* 有内容时与后面的按钮留距 */
  &:not(:empty) {
    margin-bottom: $space-3;
  }
}

/* 一行一张：缩略图、信息、操作 */
.thumb {
  display: flex;
  align-items: center;
  gap: $space-3;
  padding: $space-2 0;
  border-bottom: 1px solid var(--c-border);

  &:last-child {
    border-bottom: 0;
  }
}

.thumb__img {
  flex: none;
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--c-surface-active);
}

.thumb__info {
  flex: 1;
  min-width: 0;
}

.thumb__name {
  overflow: hidden;
  font-size: 14px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.thumb__meta {
  font-size: 12px;
  color: var(--c-text-muted);
}

.thumb__ops {
  display: flex;
  flex: none;
  gap: $space-1;
}
</style>
