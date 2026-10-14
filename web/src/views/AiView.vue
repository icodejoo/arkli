<script setup lang="ts">
// AI 页：顶部预留在线大模型配置入口（占位），下面是带 ai 标签的工具宫格
import { computed } from 'vue'
import { showToast } from 'vant'
import { useToolsStore } from '@/stores/tools'
import { TAG_AI } from '@/tools/registry'
import ToolGrid from './ToolGrid.vue'

/** 模型配置占位卡片的文案 */
const MODEL_ENTRY_TEXT = '在线大模型配置（即将支持）'

/** 工具 store */
const store = useToolsStore()
/** 带 ai 标签的工具 */
const aiTools = computed(() => store.all.filter((t) => t.tags?.includes(TAG_AI)))

/** 点击模型配置：暂未实现，只提示 */
function onModelEntry(): void {
  showToast('敬请期待')
}
</script>

<template>
  <div class="ai">
    <van-nav-bar title="AI" fixed placeholder safe-area-inset-top />
    <main class="ai__body">
      <button type="button" class="ai__model" @click="onModelEntry">
        <van-icon name="bulb-o" class="ai__model-icon" />
        <span class="ai__model-text">{{ MODEL_ENTRY_TEXT }}</span>
        <van-icon name="arrow" />
      </button>
      <h2 class="ai__label">AI 工具</h2>
      <tool-grid v-if="aiTools.length" :tools="aiTools" />
      <van-empty v-else description="暂无 AI 工具" />
    </main>
  </div>
</template>

<style lang="scss" scoped>
.ai {
  min-height: 100vh;

  &__body {
    max-width: 720px;
    margin: 0 auto;
    padding: $space-4;
    padding-bottom: calc(#{$space-4} + var(--tabbar-total));
  }

  // 模型配置入口：整行卡片
  &__model {
    display: flex;
    align-items: center;
    width: 100%;
    padding: $space-4;
    font: inherit;
    color: var(--c-text);
    text-align: left;
    background: var(--c-surface);
    border: 0;
    border-radius: var(--tool-card-radius);

    &:active {
      background: var(--c-surface-active);
    }
  }

  &__model-icon {
    margin-right: $space-3;
    font-size: 20px;
    color: var(--c-primary);
  }

  &__model-text {
    flex: 1;
  }

  &__label {
    margin: $space-4 0 $space-2 $space-1;
    font-size: 13px;
    font-weight: 500;
    color: var(--c-text-muted);
  }
}
</style>
