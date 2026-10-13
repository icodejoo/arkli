<script setup lang="ts">
// 金额转大写：输入金额，实时显示财务大写
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { moneyToUpper } from './logic'

/** 输入框内容 */
const input = ref('')

/** 转换结果；输入为空时为 null */
const result = computed(() => (input.value.trim() ? moneyToUpper(input.value) : null))

/** 输入框行内错误文案 */
const errorMsg = computed(() => (result.value && !result.value.ok ? result.value.error : ''))

/** 复制大写文本；剪贴板不可用时提示手动长按选择 */
async function copy(): Promise<void> {
  if (!result.value?.ok) return
  try {
    await navigator.clipboard.writeText(result.value.text)
    showSuccessToast('已复制')
  } catch {
    showFailToast('复制失败，请长按文字手动复制')
  }
}
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-field
        v-model="input"
        label="金额（元）"
        type="text"
        inputmode="decimal"
        placeholder="例如 100,010.05"
        autocomplete="off"
        clearable
        :error-message="errorMsg"
      />
      <p class="tool-hint hint">最多 12 位整数（千亿），超过两位小数按四舍五入。</p>
    </div>

    <template v-if="result?.ok">
      <div class="tool-result tool-result--text">
        <span class="tool-result__label">大写金额</span>
        <span class="upper">{{ result.text }}</span>
      </div>
      <van-button type="primary" block icon="description-o" @click="copy">复制</van-button>
    </template>
  </div>
</template>

<style lang="scss" scoped>
// 提示与输入框之间留点距离
.hint {
  margin-top: 8px;
}

// 大写金额：加大字号并允许选中
.upper {
  font-size: 22px;
  font-weight: 600;
  color: var(--c-primary);
  user-select: text;
}
</style>
