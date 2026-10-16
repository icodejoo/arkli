<script setup lang="ts">
// 「模型未就绪」统一提示卡：说明该功能需要本地 AI 模型、当前版本未内置
defineProps<{
  /** 功能名，如「文字识别」 */
  feature: string
  /** 模型用途，如「检测并识别图中的文字」 */
  purpose?: string
  /** 模型大小文案，如「约 21MB」 */
  size?: string
  /** 是否显示「重新检测」按钮 */
  retry?: boolean
  /** 重新检测中 */
  loading?: boolean
}>()

const emit = defineEmits<{
  /** 点了重新检测 */
  (e: 'retry'): void
}>()
</script>

<template>
  <tool-group :title="`${feature}需要本地 AI 模型`" class="ai-gap">
    <p class="tool-hint">模型未就绪：当前版本还没有内置这个模型，{{ feature }}的识别/生成这一步暂时不能用。</p>
    <p v-if="purpose" class="tool-hint">用途：{{ purpose }}</p>
    <p v-if="size" class="tool-hint">模型大小：{{ size }}（上线后按需下载）</p>
    <van-button v-if="retry" size="small" plain round :loading="loading" @click="emit('retry')">重新检测</van-button>
  </tool-group>
</template>

<style lang="scss" scoped>
.ai-gap {
  border: 1px dashed var(--c-border);
}
</style>
