<script setup lang="ts">
// 根组件：顶栏 + 路由出口
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/** 当前路由 */
const route = useRoute()
/** 路由器 */
const router = useRouter()
/** 是否在首页（首页不显示返回键） */
const isHome = computed(() => route.name === 'home')

/** 返回上一页；没有历史时回首页 */
function goBack(): void {
  if (window.history.length > 1) router.back()
  else router.replace('/')
}
</script>

<template>
  <header class="topbar">
    <button v-if="!isHome" class="topbar__back" type="button" aria-label="返回" @click="goBack">‹</button>
    <h1 class="topbar__title">Arkli</h1>
  </header>
  <main class="page">
    <router-view />
  </main>
</template>

<style lang="scss" scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: $space-2;
  padding: $space-3 $space-4;
  background: var(--c-surface);
  border-bottom: 1px solid var(--c-border);

  &__back {
    border: 0;
    background: none;
    color: var(--c-primary);
    font-size: 28px;
    line-height: 1;
    padding: 0 $space-2;
    cursor: pointer;
  }

  &__title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
}

.page {
  padding: $space-4;
  max-width: 720px;
  margin: 0 auto;
}
</style>
