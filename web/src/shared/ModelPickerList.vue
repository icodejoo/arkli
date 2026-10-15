<script setup lang="ts">
// 模型选择器的列表：只负责按状态渲染与抛出点击，逻辑在 modelPicker.ts
import type { PickerItem } from './modelPicker'

/** 要渲染的行 */
defineProps<{ items: PickerItem[] }>()
/** 点击某行 */
defineEmits<{ pick: [item: PickerItem] }>()
</script>

<template>
  <ul class="mp__list">
    <li
      v-for="it in items"
      :key="it.id"
      :class="['mp__item', `mp__item--${it.status}`]"
      :data-status="it.status"
      @click="$emit('pick', it)"
    >
      <div class="mp__text">
        <div class="mp__title">{{ it.title }}</div>
        <div class="mp__desc">{{ it.desc }}</div>
      </div>
      <span v-if="it.status === 'loading'" class="mp__spin" role="progressbar" />
      <span v-else-if="it.status === 'selected'" class="mp__check">✓</span>
    </li>
  </ul>
</template>

<style lang="scss" scoped>
.mp {
  &__list {
    margin: 0;
    padding: $space-2 0;
    list-style: none;
  }

  &__item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: $space-3 $space-4;
    color: var(--c-text);

    // 选中：主色着色
    &--selected {
      color: var(--c-primary);
    }

    // 未下载与未接入：置灰（不用 disabled，点击仍要响应）
    &--missing,
    &--unsupported {
      color: var(--c-text-muted);
      opacity: 0.6;
    }
  }

  // 下载中的转圈（不引 Vant，便于单测）
  &__spin {
    width: 16px;
    height: 16px;
    border: 2px solid var(--c-text-muted);
    border-top-color: var(--c-primary);
    border-radius: 50%;
    animation: mp-spin 0.8s linear infinite;
  }

  &__check {
    font-size: 16px;
  }

  &__title {
    font-size: 15px;
  }

  &__desc {
    margin-top: 2px;
    font-size: 12px;
    color: var(--c-text-muted);
  }
}

@keyframes mp-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
