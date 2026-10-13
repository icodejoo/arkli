<script setup lang="ts">
// 首页：工具卡片列表，点击进入 /tool/:id
import { useToolsStore } from '@/stores/tools'

/** 工具 store */
const store = useToolsStore()
</script>

<template>
  <section v-if="store.recent.length" class="block">
    <h2 class="block__title">最近使用</h2>
    <ul class="cards">
      <li v-for="t in store.recent" :key="t.id">
        <router-link class="card" :to="`/tool/${t.id}`">
          <span class="card__name">{{ t.name }}</span>
        </router-link>
      </li>
    </ul>
  </section>

  <section class="block">
    <h2 class="block__title">全部工具</h2>
    <ul class="cards">
      <li v-for="t in store.all" :key="t.id">
        <router-link class="card" :to="`/tool/${t.id}`">
          <span class="card__name">{{ t.name }}</span>
          <span class="card__desc">{{ t.description }}</span>
        </router-link>
      </li>
    </ul>
  </section>
</template>

<style lang="scss" scoped>
.block {
  margin-bottom: $space-4;

  &__title {
    margin: 0 0 $space-2;
    font-size: 14px;
    font-weight: 500;
    color: var(--c-text-muted);
  }
}

.cards {
  display: grid;
  gap: $space-3;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  margin: 0;
  padding: 0;
  list-style: none;
}

.card {
  display: flex;
  flex-direction: column;
  gap: $space-1;
  padding: $space-4;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: $radius;
  color: inherit;
  text-decoration: none;

  &:active {
    background: var(--c-surface-active);
  }

  &__name {
    font-size: 16px;
    font-weight: 600;
  }

  &__desc {
    font-size: 13px;
    color: var(--c-text-muted);
  }
}
</style>
