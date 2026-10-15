<script setup lang="ts">
// 全屏纯色展示：铺满整屏，色值与提示放在同一行、底部居中，点一下关闭；用 van-popup 以便系统返回键能先关它
import { computed } from 'vue'
import { readableOn } from './color-picker'

/**
 * 属性
 * - modelValue：是否显示，用 v-model 绑定
 * - color：要展示的颜色，`#rrggbb`
 *
 * @example
 * <color-fullscreen v-model="showFull" :color="hex" />
 */
const props = defineProps<{ modelValue: boolean; color: string }>()
/** 显示状态变化（点一下关闭、返回键关闭） */
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

/** 色值文字的字色：按底色深浅取黑或白 */
const textColor = computed(() => readableOn(props.color))
</script>

<template>
  <van-popup
    :show="modelValue"
    teleport="body"
    :overlay="false"
    :style="{ width: '100%', height: '100%', maxWidth: '100%', maxHeight: '100%' }"
    @update:show="emit('update:modelValue', $event)"
  >
    <div class="color-full" :style="{ background: color, color: textColor }" @click="emit('update:modelValue', false)">
      <div class="color-full__line">
        <span class="color-full__hex">{{ color.toUpperCase() }}</span>
        <span class="color-full__tip">点一下退出</span>
      </div>
    </div>
  </van-popup>
</template>

<style lang="scss" scoped>
/* 整屏纯色；色值和「点一下退出」放在同一行，底部居中 */
.color-full {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding-bottom: calc(24px + var(--safe-bottom));
  cursor: pointer;
  user-select: none;

  /* 色值与提示同一行，按文字基线对齐 */
  &__line {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }

  &__hex {
    font-family: monospace;
    font-size: 22px;
    font-weight: 600;
  }

  &__tip {
    font-size: 12px;
    opacity: 0.6;
  }
}
</style>
