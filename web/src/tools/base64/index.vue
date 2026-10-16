<script setup lang="ts">
// Base64 编解码：输入变化实时转换，出错只在输出区给红字提示
import BottomActions from '@/shared/BottomActions.vue'
import { computed, ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { decodeText, encodeText } from './logic'

/** 防抖毫秒数：输入较大时避免每个字符都重算 */
const DEBOUNCE_MS = 150

/** 方向：编码 / 解码 */
const mode = ref<'encode' | 'decode'>('encode')
/** 输入 */
const input = ref('')
/** 用 URL 安全字符集（仅编码生效，解码自动识别） */
const urlSafe = ref(false)
/** 保留 = 填充（仅编码生效） */
const padding = ref(true)
/** 实际参与计算的输入（防抖后） */
const settled = ref('')
/** 防抖定时器 */
let debounce: ReturnType<typeof setTimeout> | undefined

/** 当前计算结果 */
const result = computed(() => {
  if (!settled.value) return null
  return mode.value === 'encode' ? encodeText(settled.value, { urlSafe: urlSafe.value, padding: padding.value }) : decodeText(settled.value)
})
/** 输出文本 */
const output = computed(() => (result.value?.ok ? result.value.value : ''))
/** 错误提示 */
const error = computed(() => (result.value && !result.value.ok ? result.value.error : ''))

watch(input, (v) => {
  clearTimeout(debounce)
  debounce = setTimeout(() => (settled.value = v), DEBOUNCE_MS)
})

/** 复制输出 */
async function copy(): Promise<void> {
  if (!output.value) return
  if (await copyText(output.value)) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按输出框手动选择')
}

/** 粘贴到输入框，没权限时给提示 */
async function paste(): Promise<void> {
  try {
    input.value = await navigator.clipboard.readText()
    settled.value = input.value
  } catch {
    showFailToast('无法读取剪贴板，请长按输入框粘贴')
  }
}

/** 把输出换到输入框，方便连续转换 */
function swap(): void {
  if (!output.value) return
  input.value = output.value
  settled.value = output.value
  mode.value = mode.value === 'encode' ? 'decode' : 'encode'
}

/** 清空 */
function clear(): void {
  input.value = ''
  settled.value = ''
}
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="mode" type="card">
      <van-tab title="编码" name="encode" />
      <van-tab title="解码" name="decode" />
    </van-tabs>

    <tool-group title="输入">
      <van-field
        v-model="input"
        type="textarea"
        rows="4"
        autosize
        clearable
        :placeholder="mode === 'encode' ? '输入要编码的文本' : '输入 Base64（支持 URL 安全写法、缺填充、data: 前缀）'"
      />
      <div class="tool-actions b64-bar">
        <van-button size="small" plain icon="records-o" @click="paste">粘贴</van-button>
        <van-button size="small" plain icon="delete-o" @click="clear">清空</van-button>
      </div>
    </tool-group>

    <van-cell-group v-if="mode === 'encode'" class="b64-opts">
      <van-cell title="URL 安全字符集" center>
        <template #right-icon><van-switch v-model="urlSafe" size="22" /></template>
      </van-cell>
      <van-cell title="保留 = 填充" center>
        <template #right-icon><van-switch v-model="padding" size="22" /></template>
      </van-cell>
    </van-cell-group>

    <tool-group title="结果">
      <van-field :model-value="output" type="textarea" rows="4" autosize readonly placeholder="结果会显示在这里" :error-message="error" />
    </tool-group>

    <van-button plain block round :disabled="!output" @click="swap">结果作为输入</van-button>

    <!-- 底部动作栏：编码 / 解码是实时的，主操作就是复制结果 -->
    <bottom-actions main main-text="复制结果" :disabled="{ main: !output }" @main="copy" />
  </div>
</template>

<style lang="scss" scoped>
/* 输入框下方的小按钮条 */
.b64-bar {
  margin-top: $space-2;
}

/* 选项分组：去掉 inset 的左右外边距，和卡片等宽 */
.b64-opts {
  margin: 0;
  overflow: hidden;
  border-radius: var(--tool-card-radius);
}
</style>
