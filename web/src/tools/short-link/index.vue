<script setup lang="ts">
// 短链还原：逐跳请求并列出跳转链，只还原，不生成短链
import BottomActions from '@/shared/BottomActions.vue'
import { onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { copyText } from '@/shared/clipboard'
import { normalizeUrl } from '../web-source/logic'
import { MAX_HOPS, outcomeText, traceRedirects, type Hop, type TraceResult } from './logic'

/** 是否在 App 内 */
const inApp = isNativeAvailable()
/** 输入的短链 */
const input = ref('')
/** 请求中 */
const loading = ref(false)
/** 输入校验错误 */
const error = ref('')
/** 已走完的跳（实时增长） */
const hops = ref<Hop[]>([])
/** 最终结果 */
const result = ref<TraceResult | null>(null)
/** 当前追踪的取消器 */
let ac: AbortController | null = null

/** 开始还原；进行中再点等于取消 */
async function run(): Promise<void> {
  if (loading.value) {
    ac?.abort()
    return
  }
  const n = normalizeUrl(input.value)
  if (!n.ok) {
    error.value = n.error
    return
  }
  input.value = n.url
  error.value = ''
  hops.value = []
  result.value = null
  loading.value = true
  const mine = new AbortController()
  ac = mine
  const r = await traceRedirects(n.url, undefined, { signal: mine.signal, onHop: (h) => ac === mine && hops.value.push(h) })
  if (ac !== mine) return
  // 用户取消会表现为请求失败，换成更友好的说法
  result.value = mine.signal.aborted ? { ...r, outcome: 'error', error: '已取消' } : r
  loading.value = false
  ac = null
}

/** 复制最终地址 */
async function copyFinal(): Promise<void> {
  if (!result.value) return
  if (await copyText(result.value.finalUrl)) showSuccessToast('已复制')
  else showFailToast('复制失败')
}

onBeforeUnmount(() => {
  const cur = ac
  ac = null
  cur?.abort()
})
</script>

<template>
  <div class="tool-page">
    <tool-group v-if="!inApp">
      <p class="tool-hint">需要在 App 内使用：请求由 App 原生发出，浏览器里没法直接联网。</p>
    </tool-group>

    <tool-group title="短链">
      <van-field v-model="input" clearable placeholder="粘贴短链，如 t.cn/xxxx" :disabled="!inApp" @keyup.enter="run" />
      <p v-if="error" class="tool-hint sl-error">{{ error }}</p>
      <p class="tool-hint">只还原，不生成短链。最多追 {{ MAX_HOPS }} 跳，每一跳都不会自动跟随，能看清中间经过了谁。</p>
    </tool-group>

    <tool-group v-if="hops.length" title="跳转链">
      <ol class="sl-list">
        <li v-for="(h, i) in hops" :key="i" class="sl-item">
          <span class="sl-status">{{ h.status }}</span>
          <span class="sl-url">{{ h.url }}</span>
        </li>
      </ol>
    </tool-group>

    <tool-group v-if="result" title="结果">
      <p class="sl-final">{{ result.finalUrl }}</p>
      <p class="tool-hint" :class="{ 'sl-error': result.outcome !== 'done' }">
        {{ result.error ? `${outcomeText(result.outcome)}：${result.error}` : outcomeText(result.outcome) }}
      </p>
    </tool-group>

    <!-- 底部动作栏：复制最终地址，主按钮还原（还原中变成取消） -->
    <bottom-actions :actions="{ copy: { disabled: !result, text: '复制地址' } }" main :main-text="loading ? '取消' : '还原'" :main-type="loading ? 'danger' : 'primary'" :disabled="{ main: !inApp }" @main="run" @copy="copyFinal" />
  </div>
</template>

<style lang="scss" scoped>
.sl-error {
  color: var(--c-error);
}
.sl-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.sl-item {
  display: flex;
  gap: $space-2;
  padding: $space-1 0;
  font-size: 13px;
}
.sl-status {
  flex: none;
  min-width: 34px;
  color: var(--c-primary);
  font-weight: 600;
}
.sl-url {
  word-break: break-all;
}
.sl-final {
  margin: 0 0 $space-2;
  font-size: 14px;
  word-break: break-all;
}
</style>
