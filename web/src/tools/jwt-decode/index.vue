<script setup lang="ts">
// JWT 解析：只解码不验签，展示 header / payload / 签名与时间声明
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { parseJwt } from './logic'

/** JSON 缩进空格数 */
const JSON_INDENT = 2

/** 输入的 JWT */
const input = ref('')
/** 解析结果，空输入为 null */
const result = computed(() => (input.value.trim() ? parseJwt(input.value) : null))

/** 复制文本并提示 */
async function copy(text: string): Promise<void> {
  if (await copyText(text)) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按文字手动选择')
}

/** 对象转格式化 JSON */
function pretty(v: unknown): string {
  return JSON.stringify(v, null, JSON_INDENT)
}
</script>

<template>
  <div class="tool-page">
    <tool-group title="JWT">
      <van-field v-model="input" type="textarea" rows="4" autosize clearable placeholder="粘贴 JWT，如 eyJhbGciOi..." />
      <p class="tool-hint">只解码，不校验签名，不上传，数据留在本机。</p>
    </tool-group>

    <p v-if="result && !result.ok" class="tool-hint jwt-error">{{ result.error }}</p>

    <template v-if="result && result.ok">
      <tool-group v-if="result.value.expired !== null || result.value.notYet" title="状态">
        <p v-if="result.value.expired !== null" class="jwt-state" :class="result.value.expired ? 'jwt-state--bad' : 'jwt-state--ok'">
          {{ result.value.expired ? '已过期' : '未过期' }}
        </p>
        <p v-if="result.value.notYet" class="jwt-state jwt-state--bad">尚未生效</p>
      </tool-group>

      <tool-group v-if="result.value.times.length" title="时间声明（本地时区）">
        <van-cell v-for="t in result.value.times" :key="t.key" :title="t.label" :value="t.text" />
      </tool-group>

      <tool-group title="Header（点击复制）">
        <pre class="jwt-pre" @click="copy(pretty(result.value.header))">{{ pretty(result.value.header) }}</pre>
      </tool-group>
      <tool-group title="Payload（点击复制）">
        <pre class="jwt-pre" @click="copy(pretty(result.value.payload))">{{ pretty(result.value.payload) }}</pre>
      </tool-group>
      <tool-group title="Signature（原文，点击复制）">
        <pre class="jwt-pre" @click="copy(result.value.signature)">{{ result.value.signature || '（空）' }}</pre>
      </tool-group>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.jwt-error {
  color: var(--c-error);
}
.jwt-state {
  font-size: 15px;
  font-weight: 600;

  &--ok {
    color: var(--van-success-color);
  }
  &--bad {
    color: var(--c-error);
  }
}
.jwt-pre {
  margin: 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  cursor: pointer;
}
</style>
