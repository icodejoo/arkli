<script setup lang="ts">
// RC4 加解密：密钥 + 文本，输出 Base64 或十六进制；RC4 已不安全，仅用于兼容与学习
import BottomActions from '@/shared/BottomActions.vue'
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { oneOf } from '@/shared/persistValidators'
import { decryptText, ENC_VALUES, encryptText, MODE_VALUES, STORE_NS, type Encoding } from './logic'

/** 持久缓存 */
const store = createToolStorage(STORE_NS)

/** 方向：加密或解密 */
const mode = usePersistedRef<'encrypt' | 'decrypt'>(store, 'mode', 'encrypt', oneOf(MODE_VALUES))
/** 编码：Base64 或十六进制 */
const enc = usePersistedRef<Encoding>(store, 'enc', 'base64', oneOf(ENC_VALUES))
/** 方向选项 */
const MODE_OPTIONS: CellOption[] = [
  { value: 'encrypt', label: '加密' },
  { value: 'decrypt', label: '解密' },
]
/** 密文编码选项 */
const ENC_OPTIONS: CellOption[] = [
  { value: 'base64', label: 'Base64' },
  { value: 'hex', label: '十六进制' },
]
/** 密钥文本 */
const key = ref('')
/** 输入文本 */
const input = ref('')

/** 当前结果；输入为空时不计算 */
const result = computed(() => {
  if (!input.value) return null
  return mode.value === 'encrypt' ? encryptText(key.value, input.value, enc.value) : decryptText(key.value, input.value, enc.value)
})
/** 输出文本 */
const output = computed(() => (result.value?.ok ? result.value.text : ''))
/** 错误提示 */
const error = computed(() => (result.value && !result.value.ok ? result.value.error : ''))

/** 把输出换到输入，方便来回验证 */
function swap(): void {
  if (!output.value) return
  input.value = output.value
  mode.value = mode.value === 'encrypt' ? 'decrypt' : 'encrypt'
}

/** 复制输出 */
async function copy(): Promise<void> {
  if (!output.value) return
  if (await copyText(output.value)) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按文字手动选择')
}
</script>

<template>
  <div class="tool-page">
    <p class="tool-hint">RC4 已不安全，仅用于兼容旧系统与学习，别拿它保护重要数据。</p>

    <tool-group>
      <cell-picker :model-value="mode" title="方向" :options="MODE_OPTIONS" @update:model-value="mode = $event as 'encrypt' | 'decrypt'" />
      <cell-picker :model-value="enc" title="密文编码" :options="ENC_OPTIONS" @update:model-value="enc = $event as Encoding" />
    </tool-group>

    <tool-group title="密钥（UTF-8 文本）">
      <van-field v-model="key" clearable autocomplete="off" :spellcheck="false" placeholder="例如 Key" />
      <h3 class="tool-group__title rc4-gap">{{ mode === 'encrypt' ? '明文' : '密文' }}</h3>
      <van-field v-model="input" type="textarea" rows="3" autosize clearable :spellcheck="false" :error-message="error" placeholder="在这里输入" />
    </tool-group>

    <tool-group :title="`${mode === 'encrypt' ? '密文' : '明文'}`">
      <p class="rc4-out">{{ output || '（结果显示在这里）' }}</p>
      <div class="rc4-btns">
        <van-button size="small" plain :disabled="!output" @click="swap">结果换到输入</van-button>
      </div>
    </tool-group>

    <!-- 底部动作栏：加解密是实时的，主操作就是复制结果 -->
    <bottom-actions main main-text="复制结果" :disabled="{ main: !output }" @main="copy" />
  </div>
</template>

<style lang="scss" scoped>
/* 卡片内小标题与上方留距 */
.rc4-gap {
  margin-top: $space-3;
}

/* 输出文本 */
.rc4-out {
  margin: 0 0 $space-3;
  font: 14px ui-monospace, Menlo, Consolas, monospace;
  word-break: break-all;
  white-space: pre-wrap;
  color: var(--c-text);
}

/* 按钮行 */
.rc4-btns {
  display: flex;
  gap: $space-2;
}
</style>
