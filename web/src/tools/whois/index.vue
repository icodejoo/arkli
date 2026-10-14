<script setup lang="ts">
// Whois 查询：优先 RDAP 结构化结果，查不到再显示 Whois 原文
import { computed, onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { copyText } from '@/shared/clipboard'
import { formatRdapDate, normalizeDomain, queryDomain, type WhoisOutcome } from './logic'

/** 是否在 App 内 */
const inApp = isNativeAvailable()
/** 输入 */
const input = ref('')
/** 查询中 */
const loading = ref(false)
/** 错误提示 */
const error = ref('')
/** 查询结果 */
const result = ref<WhoisOutcome | null>(null)
/** 当前请求的取消器 */
let ac: AbortController | null = null

/** RDAP 结构化条目，供列表渲染 */
const rows = computed<Array<[string, string]>>(() => {
  const r = result.value
  if (!r || r.kind !== 'rdap') return []
  const d = r.data
  const list: Array<[string, string]> = [['域名', d.domain], ['注册商', d.registrar || '—']]
  list.push(['注册时间', d.registered ? formatRdapDate(d.registered) : '—'])
  list.push(['到期时间', d.expires ? formatRdapDate(d.expires) : '—'])
  list.push(['更新时间', d.updated ? formatRdapDate(d.updated) : '—'])
  list.push(['状态', d.status.join('、') || '—'])
  list.push(['DNS 服务器', d.nameservers.join('\n') || '—'])
  return list
})

/** 查询；进行中再点等于取消 */
async function run(): Promise<void> {
  if (loading.value) {
    ac?.abort()
    return
  }
  const domain = normalizeDomain(input.value)
  if (!domain) {
    error.value = '域名格式不对（中文域名请先转成 xn-- 开头的 punycode）'
    return
  }
  input.value = domain
  error.value = ''
  result.value = null
  loading.value = true
  const mine = new AbortController()
  ac = mine
  try {
    const r = await queryDomain(domain, undefined, mine.signal)
    if (ac === mine) result.value = r
  } catch (e) {
    if (ac === mine) error.value = mine.signal.aborted ? '已取消' : (e as { message?: string }).message || '查询失败'
  } finally {
    if (ac === mine) {
      loading.value = false
      ac = null
    }
  }
}

/** 复制全部结果 */
async function copyAll(): Promise<void> {
  const r = result.value
  if (!r) return
  const text = r.kind === 'whois' ? r.text : rows.value.map(([k, v]) => `${k}：${v.replace(/\n/g, ' ')}`).join('\n')
  if (await copyText(text)) showSuccessToast('已复制')
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
    <div v-if="!inApp" class="tool-card">
      <p class="tool-hint">需要在 App 内使用：查询由 App 原生发出，浏览器里没法直接联网。</p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">域名</h3>
      <van-field v-model="input" clearable placeholder="example.com，也可以粘贴完整网址" :disabled="!inApp" @keyup.enter="run" />
      <van-button type="primary" block class="wh-btn" :disabled="!inApp" @click="run">
        {{ loading ? '查询中，点此取消' : '查询' }}
      </van-button>
      <p v-if="error" class="tool-hint wh-error">{{ error }}</p>
      <p class="tool-hint">先查 RDAP（rdap.org），查不到再走 43 端口的 Whois 原文。很多注册局已隐去个人信息，查不到联系人是正常的。</p>
    </div>

    <div v-if="result" class="tool-card">
      <h3 class="tool-card__title">{{ result.kind === 'rdap' ? 'RDAP 结果' : `Whois 原文（${result.server}）` }}</h3>
      <template v-if="result.kind === 'rdap'">
        <div v-for="[k, v] in rows" :key="k" class="wh-row">
          <span class="wh-k">{{ k }}</span>
          <span class="wh-v">{{ v }}</span>
        </div>
      </template>
      <template v-else>
        <pre class="wh-raw">{{ result.text }}</pre>
        <p v-if="result.truncated" class="tool-hint">原文超过 64KB，已截断。</p>
      </template>
      <van-button size="small" plain class="wh-copy" @click="copyAll">复制</van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.wh-btn {
  margin-top: $space-2;
}
.wh-error {
  color: var(--c-error);
}
.wh-row {
  display: flex;
  gap: $space-2;
  padding: $space-1 0;
  font-size: 14px;
}
.wh-k {
  flex: none;
  width: 78px;
  color: var(--c-text-muted);
}
.wh-v {
  white-space: pre-line;
  word-break: break-all;
}
.wh-raw {
  max-height: 60vh;
  margin: 0;
  overflow: auto;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
.wh-copy {
  margin-top: $space-2;
}
</style>
