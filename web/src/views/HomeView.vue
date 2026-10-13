<script setup lang="ts">
// 首页：标题 + 搜索 + 最近使用宫格 + 全部工具宫格，点击进入 /tool/:id
import { computed, ref } from 'vue'
import { useToolsStore } from '@/stores/tools'
import { filterTools } from './toolFilter'
import { toolIcon } from './toolIcons'

/** 宫格列数：360px 宽下 4 列，名称最多两行 */
const GRID_COLUMNS = 4
/** 最近使用只显示一行 */
const RECENT_SHOWN = GRID_COLUMNS

/** 工具 store */
const store = useToolsStore()
/** 搜索词 */
const keyword = ref('')
/** 过滤后的全部工具 */
const filtered = computed(() => filterTools(store.all, keyword.value))
/** 最近使用（一行）；搜索时隐藏 */
const recent = computed(() => (keyword.value.trim() ? [] : store.recent.slice(0, RECENT_SHOWN)))
</script>

<template>
  <div class="home">
    <header class="home__head">
      <h1 class="home__title">Arkli</h1>
      <p class="home__sub">小工具，装一箱</p>
    </header>

    <van-search v-model="keyword" shape="round" placeholder="搜索工具名称或简介" />

    <section v-if="recent.length" class="home__block">
      <h2 class="home__label">最近使用</h2>
      <van-grid class="home__grid" :column-num="GRID_COLUMNS" :border="false">
        <van-grid-item v-for="t in recent" :key="t.id" :to="`/tool/${t.id}`">
          <span class="home__icon">{{ toolIcon(t.id) }}</span>
          <span class="home__name">{{ t.name }}</span>
        </van-grid-item>
      </van-grid>
    </section>

    <section class="home__block">
      <h2 class="home__label">全部工具</h2>
      <van-grid v-if="filtered.length" class="home__grid" :column-num="GRID_COLUMNS" :border="false">
        <van-grid-item v-for="t in filtered" :key="t.id" :to="`/tool/${t.id}`">
          <span class="home__icon">{{ toolIcon(t.id) }}</span>
          <span class="home__name">{{ t.name }}</span>
        </van-grid-item>
      </van-grid>
      <van-empty v-else description="没有匹配的工具" />
    </section>
  </div>
</template>

<style lang="scss" scoped>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: calc(env(safe-area-inset-top) + #{$space-4}) 0 calc(env(safe-area-inset-bottom) + #{$space-4});

  &__head {
    padding: $space-2 $space-4 0;
  }

  &__title {
    margin: 0;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 0.5px;
  }

  &__sub {
    margin: 0;
    font-size: 13px;
    color: var(--c-text-muted);
  }

  &__block {
    padding: 0 $space-4;
    margin-top: $space-2;
  }

  &__label {
    margin: $space-3 0 $space-2 $space-1;
    font-size: 13px;
    font-weight: 500;
    color: var(--c-text-muted);
  }

  // 宫格整体做成一张圆角卡片，格子之间靠留白区分
  &__grid {
    overflow: hidden;
    border-radius: var(--van-radius-lg);
    background: var(--c-surface);
  }

  &__icon {
    font-size: 28px;
    line-height: 1.2;
  }

  &__name {
    margin-top: $space-2;
    font-size: 12px;
    line-height: 1.3;
    text-align: center;
    color: var(--c-text);
    // 名称最多两行，超出省略
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
}
</style>
