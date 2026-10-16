<script setup lang="ts">
// 通用缩略图预览：默认触发器是缩略图方块（可带扫描效果），点击走原生全屏预览，无宿主退回 vant 预览。
// 需要别的触发样式就用默认插槽整个替换，点击行为不变。
import { showImagePreview, showToast } from 'vant'
import { call, isNativeAvailable } from '@/native/bridge'

/** 预览失败提示 */
const MSG_PREVIEW_FAILED = '预览失败'

/**
 * 属性：
 * - url 可显示地址（缩略图与无宿主预览用）
 * - path 原生缓存相对路径（有宿主时用它拉原生预览），无则退回 vant 预览
 * - alt 图片说明
 * - size 缩略图边长（px），默认 56
 * - scanning 是否显示扫描效果（处理中）
 *
 * @example <thumb-preview :url="it.url" :path="it.path" :scanning="busy" />
 */
const props = withDefaults(defineProps<{ url: string; path?: string; alt?: string; size?: number; scanning?: boolean }>(), { size: 56 })

/** 触发预览：有宿主且有缓存路径走原生，否则 vant */
async function open(): Promise<void> {
  try {
    if (isNativeAvailable() && props.path) await call('native.image.preview', { paths: [props.path] })
    else showImagePreview({ images: [props.url] })
  } catch (e) {
    showToast((e as { message?: string }).message ?? MSG_PREVIEW_FAILED)
  }
}
</script>

<template>
  <div class="tp" :style="{ width: `${size}px`, height: `${size}px`, '--tp-size': `${size}px` }" @click.stop="open">
    <slot>
      <img class="tp__img" :src="url" :alt="alt" />
    </slot>
    <div v-if="scanning" class="tp__scan" aria-hidden="true" />
  </div>
</template>

<style lang="scss" scoped>
.tp {
  position: relative;
  flex: none;
  margin-right: $space-3;
  overflow: hidden;
  contain: strict;
  border-radius: 6px;
}

.tp__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

// 扫描线：沿缩略图上下往返，带光晕
.tp__scan {
  position: absolute;
  right: 0;
  left: 0;
  top: 0;
  height: 3px;
  pointer-events: none;
  will-change: transform;
  background: linear-gradient(90deg, transparent, var(--c-primary, #1989fa), transparent);
  box-shadow: 0 0 6px 1px var(--c-primary, #1989fa);
  animation: tp-scan 1.6s ease-in-out infinite alternate;
}

// 只动 transform：不触发布局与重绘，避免整屏抖动
@keyframes tp-scan {
  from {
    transform: translateY(0);
  }

  to {
    transform: translateY(calc(var(--tp-size) - 3px));
  }
}
</style>
