<script setup lang="ts">
// RC4 加解密：密钥 + 文本，输出 Base64 或十六进制；RC4 已不安全，仅用于兼容与学习
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { decryptText, encryptText, type Encoding } from './logic'

/** 方向：加密或解密 */
const mode = ref<'encrypt' | 'decrypt'>('encrypt')
/** 编码：Base64 或十六进制 */
const enc = ref<Encoding>('base64')
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

    <div class="tool-card">
      <van-radio-group v-model="mode" direction="horizontal">
        <van-radio name="encrypt">加密</van-radio>
        <van-radio name="decrypt">解密</van-radio>
      </van-radio-group>
      <h3 class="tool-card__title rc4-gap">密文编码</h3>
      <van-radio-group v-model="enc" direction="horizontal">
        <van-radio name="base64">Base64</van-radio>
        <van-radio name="hex">十六进制</van-radio>
      </van-radio-group>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">密钥（UTF-8 文本）</h3>
      <van-field v-model="key" clearable autocomplete="off" :spellcheck="false" placeholder="例如 Key" />
      <h3 class="tool-card__title rc4-gap">{{ mode === 'encrypt' ? '明文' : '密文' }}</h3>
      <van-field v-model="input" type="textarea" rows="3" autosize clearable :spellcheck="false" :error-message="error" placeholder="在这里输入" />
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">{{ mode === 'encrypt' ? '密文' : '明文' }}</h3>
      <p class="rc4-out">{{ output || '（结果显示在这里）' }}</p>
      <div class="rc4-btns">
        <van-button size="small" plain :disabled="!output" @click="copy">复制</van-button>
        <van-button size="small" plain :disabled="!output" @click="swap">结果换到输入</van-button>
      </div>
    </div>
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
