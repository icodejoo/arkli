<script setup lang="ts">
// 通用底部动作栏：按 items 顺序渲染，每项可自定义文字，也可用具名插槽 `item-<key>` 整项替换（如放模型选择器）
import type { BottomActionItem } from './bottomActions'

/** 动作项列表（顺序即显示顺序；一般最后一项用 button 作主按钮） */
defineProps<{ items: BottomActionItem[] }>()
/** 点击某项（带 key；禁用项不触发） */
defineEmits<{ select: [key: string] }>()
</script>

<template>
  <van-action-bar class="ba" placeholder :safe-area-inset-bottom="false">
    <template v-for="it in items" :key="it.key">
      <!-- 插槽优先：调用方传了 item-<key> 就整项交给它 -->
      <slot v-if="$slots[`item-${it.key}`]" :name="`item-${it.key}`" :item="it" />
      <van-action-bar-button
        v-else-if="it.kind === 'button'"
        :type="it.type ?? 'primary'"
        :icon="it.icon"
        :text="it.text"
        :disabled="it.disabled"
        @click="$emit('select', it.key)"
      />
      <van-action-bar-icon
        v-else
        plain
        type="primary"
        :icon="it.icon"
        :text="it.text"
        :disabled="it.disabled"
        @click="$emit('select', it.key)"
      />
    </template>
  </van-action-bar>
</template>

<style lang="scss" scoped>
/* 避开手势条 */
.ba {
  padding-bottom: var(--safe-bottom);
}
</style>
