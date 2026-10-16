<script setup lang="ts">
// AI 应用页（AI 中心的二级路由）：带 ai 标签的工具宫格
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useToolsStore } from '@/stores/tools'
import { TAG_AI } from '@/tools/registry'
import ToolGrid from './ToolGrid.vue'

/** AI 中心的路径，没有历史时返回到这里 */
const AI_PATH = '/ai'

/** 路由器 */
const router = useRouter()
/** 工具 store */
const store = useToolsStore()
/** 带 ai 标签的工具 */
const aiTools = computed(() => store.all.filter((t) => t.tags?.includes(TAG_AI)))

/** 返回上一页；没有历史（如直接打开深链）时回 AI 中心 */
function goBack(): void {
  if (window.history.length > 1) router.back()
  else void router.replace(AI_PATH)
}
</script>

<template>
  <div class="ai-apps">
    <van-nav-bar title="AI 应用" left-arrow fixed placeholder safe-area-inset-top @click-left="goBack" />
    <main class="ai-apps__body">
      <tool-grid v-if="aiTools.length" :tools="aiTools" />
      <van-empty v-else description="暂无 AI 应用" />
    </main>
  </div>
</template>

<style lang="scss" scoped>
.ai-apps {
  min-height: 100vh;

  &__body {
    max-width: 720px;
    margin: 0 auto;
    padding: $space-4;
  }
}
</style>
