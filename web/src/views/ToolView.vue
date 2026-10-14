<script setup lang="ts">
// 工具容器页：顶部导航栏 + 内容区（安全区内边距），按路由 id 异步加载工具组件
import { computed, defineAsyncComponent, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { findTool } from '@/tools/registry'
import { useToolsStore } from '@/stores/tools'

/** 路由参数：工具 id */
const props = defineProps<{ id: string }>()

/** 路由器 */
const router = useRouter()
/** 工具 store */
const store = useToolsStore()
/** 当前工具元信息 */
const meta = computed(() => findTool(props.id))
/** 当前工具的异步组件；id 不存在时为 null */
const ToolComponent = computed(() => (meta.value ? defineAsyncComponent(meta.value.load) : null))

/** 返回上一页；没有历史（如直接打开深链）时回首页 */
function goBack(): void {
  if (window.history.length > 1) router.back()
  else router.replace('/')
}

// 打开有效工具时记入最近使用
watchEffect(() => {
  if (meta.value) store.markUsed(meta.value.id)
})
</script>

<template>
  <div class="shell">
    <van-nav-bar
      class="shell__nav"
      :title="meta?.name ?? '未找到工具'"
      left-arrow
      fixed
      placeholder
      safe-area-inset-top
      @click-left="goBack"
    />
    <main class="shell__body">
      <component :is="ToolComponent" v-if="ToolComponent" :key="props.id" />
      <van-empty v-else description="没有找到这个工具" />
    </main>
  </div>
</template>

<style lang="scss" scoped>
.shell {
  min-height: 100vh;

  &__body {
    max-width: 720px;
    margin: 0 auto;
    padding: $space-4;
    padding-bottom: calc(#{$space-4} + var(--safe-bottom));
  }
}
</style>
