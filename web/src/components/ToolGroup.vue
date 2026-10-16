<script setup lang="ts">
// 工具页分组：就是 van-cell-group，仅在有标题时外面多包一层无样式 div，
// 让标题和内容（van-cell-group 里它俩是兄弟节点）有同一个根元素，方便页面布局。

/**
 * 组件属性。
 * - title：分组标题（可选；有则外面包一层 div）
 * - border：是否显示上下分隔线，默认显示
 * @example <tool-group title="输入"><van-field v-model="text" /></tool-group>
 */
withDefaults(defineProps<{ title?: string; border?: boolean }>(), { border: true })
</script>

<template>
  <div v-if="title || $slots.title">
    <van-cell-group class="tool-group" :title="title" :border="border">
      <template v-if="$slots.title" #title><slot name="title" /></template>
      <slot />
    </van-cell-group>
  </div>
  <van-cell-group v-else class="tool-group" :border="border"><slot /></van-cell-group>
</template>
