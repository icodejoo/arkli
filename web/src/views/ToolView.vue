<script setup lang="ts">
// 工具容器页：按路由 id 从注册表取组件并异步加载
import { computed, defineAsyncComponent, watchEffect } from 'vue'
import { findTool } from '@/tools/registry'
import { useToolsStore } from '@/stores/tools'

/** 路由参数：工具 id */
const props = defineProps<{ id: string }>()

/** 工具 store */
const store = useToolsStore()
/** 当前工具元信息 */
const meta = computed(() => findTool(props.id))
/** 当前工具的异步组件；id 不存在时为 null */
const ToolComponent = computed(() => (meta.value ? defineAsyncComponent(meta.value.load) : null))

// 打开有效工具时记入最近使用
watchEffect(() => {
  if (meta.value) store.markUsed(meta.value.id)
})
</script>

<template>
  <component :is="ToolComponent" v-if="ToolComponent" :key="props.id" />
  <p v-else class="empty">没有找到这个工具：{{ props.id }}</p>
</template>

<style lang="scss" scoped>
.empty {
  color: var(--c-text-muted);
}
</style>
