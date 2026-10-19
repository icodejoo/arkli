<script setup lang="ts">
/**
 * MNN 基础参数弹窗：展示与调整所有本地模型共用的 MNN 引擎参数（如计算线程数等）。
 * 仅在 AI 中心使用。
 */
import ModelParamsPanel from './ModelParamsPanel.vue'

/** MNN 提供者唯一标识 */
const PROVIDER_ID = 'mnn'

/** 弹窗主标题 */
const TITLE = 'MNN 基础参数'

/** 功能简短说明文案 */
const DESCRIPTION = '所有本地模型共用，语音输入不受影响。'

/** 面板是否显示（v-model） */
const show = defineModel<boolean>({ required: true })
</script>

<template>
  <van-popup v-model:show="show" position="bottom" round closeable :style="{ maxHeight: '85vh' }">
    <div class="mnn-sheet">
      <h3 class="mnn-sheet__title">{{ TITLE }}</h3>
      <p class="mnn-sheet__desc">{{ DESCRIPTION }}</p>
      <model-params-panel :provider-id="PROVIDER_ID" />
    </div>
  </van-popup>
</template>

<style lang="scss" scoped>
.mnn-sheet {
  max-height: 85vh;
  padding: $space-4;
  padding-top: $space-5;
  padding-bottom: calc(#{$space-4} + var(--safe-bottom));
  overflow-y: auto;

  &__title {
    padding-right: 32px; // 给右上角关闭按钮留位
    margin: 0 0 $space-2;
    font-size: 16px;
    font-weight: 600;
  }

  &__desc {
    margin: 0 0 $space-3;
    font-size: 12px;
    line-height: 1.5;
    color: var(--c-text-muted);
  }
}
</style>
