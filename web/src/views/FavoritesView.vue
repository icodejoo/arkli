<script setup lang="ts">
// 收藏页：按收藏顺序列出已收藏工具，空时给提示
import { useFavoritesStore } from '@/stores/favorites'
import ToolGrid from './ToolGrid.vue'

/** 空状态文案 */
const EMPTY_TEXT = '还没有收藏，去工具页点右上角的星标'

/** 收藏 store */
const store = useFavoritesStore()
</script>

<template>
  <div class="fav">
    <van-nav-bar title="收藏" fixed placeholder safe-area-inset-top />
    <main class="fav__body">
      <tool-grid v-if="store.list.length" :tools="store.list" />
      <van-empty v-else :description="EMPTY_TEXT" />
    </main>
  </div>
</template>

<style lang="scss" scoped>
.fav {
  min-height: 100vh;

  &__body {
    max-width: 720px;
    margin: 0 auto;
    padding: $space-4;
    padding-bottom: calc(#{$space-4} + var(--tabbar-total));
  }
}
</style>
