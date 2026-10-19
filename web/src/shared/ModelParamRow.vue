<script setup lang="ts">
/**
 * 可调参数的一行：标题、说明、生效范围提示和按 spec.kind 渲染的控件。
 * 只负责展示与上报，提交与回滚由 ModelParamsPanel 处理。
 */
import type { AiParamSpec } from '@/native/ai'
import {
  RESET_ITEM_LABEL,
  SESSION_RELOAD_HINT,
  formatApplyToText,
  formatParamValue,
  isModified,
  selectIndex,
  selectValue,
} from './modelParams'

/** 组件属性 */
defineProps<{
  /** 参数规格 */
  spec: AiParamSpec
}>()

/** 当前显示值（拖动中的本地值） */
const value = defineModel<number>({ required: true })

/** 事件：commit 提交新值；reset 单项恢复默认 */
const emit = defineEmits<{
  /** 用户确认了新值（滑块松手、步进点击、开关、选项） */
  commit: [value: number]
  /** 用户点了单项重置 */
  reset: []
}>()
</script>

<template>
  <div class="mpp-row">
    <div class="mpp-row__header">
      <div class="mpp-row__meta">
        <span class="mpp-row__label">{{ spec.label }}</span>
        <span class="mpp-row__desc">{{ spec.desc }}</span>
      </div>
      <van-icon
        v-if="isModified(spec, value)"
        name="replay"
        class="mpp-row__reset"
        :title="RESET_ITEM_LABEL"
        :aria-label="RESET_ITEM_LABEL"
        @click="emit('reset')"
      />
    </div>

    <div v-if="spec.applyTo?.length" class="mpp-row__subtip">
      {{ formatApplyToText(spec.applyTo) }}
    </div>
    <div v-if="spec.scope === 'session'" class="mpp-row__subtip mpp-row__subtip--session">
      {{ SESSION_RELOAD_HINT }}
    </div>

    <div class="mpp-row__ctrl">
      <!-- slider 滑块：只在松手时提交 -->
      <div v-if="spec.kind === 'slider'" class="mpp-slider">
        <van-slider
          v-model="value"
          :min="spec.min"
          :max="spec.max"
          :step="spec.step"
          :data-key="spec.key"
          class="mpp-slider__bar"
          @change="emit('commit', Number($event))"
        />
        <span class="mpp-slider__val">{{ formatParamValue(spec, value) }}</span>
      </div>

      <!-- stepper 步进器 -->
      <van-stepper
        v-else-if="spec.kind === 'stepper'"
        v-model="value"
        :min="spec.min"
        :max="spec.max"
        :step="spec.step"
        @change="emit('commit', Number($event))"
      />

      <!-- switch 开关 -->
      <van-switch
        v-else-if="spec.kind === 'switch'"
        :model-value="!!value"
        size="20px"
        @update:model-value="emit('commit', $event ? 1 : 0)"
      />

      <!-- select 分段单选：有 optionValues 时值为真实值，否则为下标 -->
      <div v-else-if="spec.kind === 'select' && spec.options?.length" class="mpp-seg">
        <button
          v-for="(opt, idx) in spec.options"
          :key="idx"
          type="button"
          :class="['mpp-seg__btn', { 'mpp-seg__btn--active': selectIndex(spec, value ?? spec.default) === idx }]"
          @click="emit('commit', selectValue(spec, idx))"
        >
          {{ opt }}
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.mpp-row {
  padding: $space-2 0;
  border-bottom: 1px dashed var(--c-border);

  &:last-child {
    border-bottom: none;
  }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: $space-1;
  }

  &__meta {
    display: flex;
    flex-direction: column;
    flex: 1;
  }

  &__label {
    font-size: 13px;
    font-weight: 500;
    color: var(--c-text);
  }

  &__desc {
    font-size: 11px;
    color: var(--c-text-muted);
    margin-top: 2px;
  }

  &__reset {
    font-size: 16px;
    color: var(--c-text-muted);
    cursor: pointer;
    padding: $space-1;

    &:active {
      opacity: 0.7;
    }
  }

  &__subtip {
    font-size: 11px;
    color: var(--c-text-muted);
    margin-bottom: $space-1;

    &--session {
      color: var(--c-warn-text);
    }
  }

  &__ctrl {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-top: $space-1;
  }
}

.mpp-slider {
  display: flex;
  align-items: center;
  width: 100%;
  gap: $space-3;

  &__bar {
    flex: 1;
  }

  &__val {
    min-width: 32px;
    font-size: 12px;
    text-align: right;
    color: var(--c-text);
  }
}

.mpp-seg {
  display: flex;
  background: var(--c-surface-active);
  border-radius: 4px;
  padding: 2px;
  gap: 2px;

  &__btn {
    border: none;
    background: transparent;
    padding: 4px 10px;
    font-size: 12px;
    border-radius: 3px;
    color: var(--c-text-muted);
    cursor: pointer;

    &--active {
      background: var(--c-surface);
      color: var(--c-text);
      font-weight: 500;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
    }
  }
}
</style>
