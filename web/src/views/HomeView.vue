<script setup lang="ts">
// 首页：标题 + 搜索 + 最近使用宫格 + 全部工具宫格，点击进入 /tool/:id
import { computed, ref } from 'vue'
import { useToolsStore } from '@/stores/tools'
import { filterTools } from './toolFilter'
import logo from '@/assets/arkli-icon.svg'
import ToolGrid from './ToolGrid.vue'
import { GRID_COLUMNS } from './toolGrid'

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
    <!-- 状态栏位置的遮罩：窗口是边到边的，内容滚上去时盖住，免得和状态栏的时间、电量叠在一起 -->
    <div class="home__scrim" aria-hidden="true" />
    <header class="home__head">
      <h1 class="home__title"><img class="home__logo" :src="logo" alt="Arkli" /></h1>
    </header>

    <van-search v-model="keyword" shape="round" placeholder="搜索工具名称或简介" />

    <section v-if="recent.length" class="home__block">
      <h2 class="home__label">最近使用</h2>
      <tool-grid :tools="recent" />
    </section>

    <section class="home__block">
      <h2 class="home__label">全部工具</h2>
      <tool-grid v-if="filtered.length" :tools="filtered" />
      <van-empty v-else description="没有匹配的工具" />
    </section>
  </div>
</template>

<style lang="scss" scoped>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: calc(var(--safe-top) + #{$space-4}) 0 calc(var(--tabbar-total) + #{$space-4});

  &__head {
    padding: $space-2 $space-4 0;
  }

  // 状态栏遮罩：固定在顶部，高度等于顶部安全区，颜色同页面底色
  &__scrim {
    position: fixed;
    top: 0;
    right: 0;
    left: 0;
    z-index: 10;
    height: var(--safe-top);
    background: var(--c-bg);
    pointer-events: none;
  }

  // 标题是应用图标；h1 保留给读屏，图片的 alt 就是名字
  &__title {
    margin: 0;
    line-height: 0;
  }

  &__logo {
    display: block;
    width: $logo-size;
    height: $logo-size;
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

}
</style>
