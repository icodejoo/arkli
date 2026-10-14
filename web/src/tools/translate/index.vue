<script setup lang="ts">
// 翻译：不自己翻，把文字交给手机上已装的翻译应用；没有就给网页入口
import { ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { processText } from '@/native/system'
import { TEXT_MAX, WEB_ENTRIES } from './data'

/** 输入文字 */
const input = ref('')
/** 是否没有应用接手（显示备选入口） */
const unhandled = ref(false)
/** 正在转交 */
const busy = ref(false)

/** 交给翻译应用 */
async function openApp(): Promise<void> {
  const t = input.value.trim()
  if (!t) return
  busy.value = true
  unhandled.value = false
  try {
    unhandled.value = !(await processText(t))
  } catch {
    unhandled.value = true
  } finally {
    busy.value = false
  }
}

/** 复制文本 */
async function copy(): Promise<void> {
  if (await copyText(input.value)) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}

/** 打开网页翻译入口 */
function openWeb(url: string): void {
  window.open(url, '_blank')
}
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-field v-model="input" type="textarea" rows="5" autosize placeholder="粘贴或输入要翻译的文字" :maxlength="TEXT_MAX" show-word-limit />
    </div>
    <van-button type="primary" block round :disabled="!input.trim()" :loading="busy" @click="openApp">用翻译应用打开</van-button>

    <div v-if="unhandled" class="tool-card">
      <h3 class="tool-card__title">没能交给翻译应用</h3>
      <p class="tool-hint">要么手机上没有能处理文本的翻译应用，要么当前不在 Arkli 应用内。可以先复制文本，再去下面的网页里粘贴。</p>
      <van-button block round plain @click="copy">复制文本</van-button>
      <van-cell-group :border="false" class="tr-gap">
        <van-cell v-for="e in WEB_ENTRIES" :key="e.url" :title="e.name" :label="e.url" is-link @click="openWeb(e.url)" />
      </van-cell-group>
    </div>
    <p v-else class="tool-hint">文字不会上传到 Arkli 的任何服务器，只会交给你选的应用。</p>
  </div>
</template>

<style lang="scss" scoped>
.tr-gap {
  margin-top: $space-3;
}
</style>
