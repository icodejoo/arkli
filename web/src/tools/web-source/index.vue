<script setup lang="ts">
// 网页源码获取：经原生请求，正文只当纯文本显示，不执行脚本、不渲染 HTML
import { computed, onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { netHttp, type HttpResponse } from '@/native/net'
import { copyText } from '@/shared/clipboard'
import { saveBlob } from '@/shared/image-io'
import { clipBody, normalizeUrl, sortHeaders, sourceFileName } from './logic'

/** 是否在 App 内 */
const inApp = isNativeAvailable()
/** 输入的网址 */
const input = ref('')
/** 请求中 */
const loading = ref(false)
/** 错误提示 */
const error = ref('')
/** 最近一次响应 */
const result = ref<HttpResponse | null>(null)
/** 响应头折叠面板展开项 */
const openHeaders = ref<string[]>([])
/** 当前请求的取消器 */
let ac: AbortController | null = null

/** 正文显示结果 */
const shown = computed(() => (result.value ? clipBody(result.value.body) : null))
/** 排序后的响应头 */
const headerList = computed(() => (result.value ? sortHeaders(result.value.headers) : []))
/** 正文是否被原生截断（2MB） */
const nativeTruncated = computed(() => result.value?.truncated === true)

/** 发请求；进行中再点等于取消 */
async function fetchSource(): Promise<void> {
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
  loading.value = true
  const mine = new AbortController()
  ac = mine
  try {
    const res = await netHttp({ url: n.url, responseType: 'text' }, undefined, mine.signal)
    if (ac !== mine) return
    result.value = res
  } catch (e) {
    if (ac !== mine) return
    result.value = null
    error.value = mine.signal.aborted ? '已取消' : (e as { message?: string }).message || '请求失败'
  } finally {
    if (ac === mine) {
      loading.value = false
      ac = null
    }
  }
}

/** 复制正文 */
async function copyBody(): Promise<void> {
  if (!result.value) return
  if (await copyText(result.value.body)) showSuccessToast('已复制')
  else showFailToast('复制失败')
}

/** 保存为文件 */
async function saveBody(): Promise<void> {
  if (!result.value) return
  const name = sourceFileName(result.value.url, result.value.headers['content-type'])
  try {
    await saveBlob(new Blob([result.value.body], { type: 'text/plain' }), name)
    showSuccessToast('已保存')
  } catch {
    showFailToast('保存失败')
  }
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
      <p class="tool-hint">需要在 App 内使用：网页请求由 App 原生发出，浏览器里没法直接联网。</p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">网址</h3>
      <van-field v-model="input" clearable placeholder="example.com 或 https://…" :disabled="!inApp" @keyup.enter="fetchSource" />
      <van-button type="primary" block class="ws-btn" :disabled="!inApp" @click="fetchSource">
        {{ loading ? '请求中，点此取消' : '获取源码' }}
      </van-button>
      <p v-if="error" class="tool-hint ws-error">{{ error }}</p>
      <p class="tool-hint">只当文本显示，不会执行脚本，也不会渲染页面。</p>
    </div>

    <template v-if="result && shown">
      <div class="tool-card">
        <h3 class="tool-card__title">响应</h3>
        <p class="ws-line">状态：{{ result.status }} {{ result.statusText }}，耗时 {{ result.elapsedMs }} ms</p>
        <p class="ws-line ws-break">最终地址：{{ result.url }}</p>
        <p v-if="result.redirects.length" class="ws-line">经过 {{ result.redirects.length }} 次跳转</p>
        <van-collapse v-model="openHeaders">
          <van-collapse-item :title="`响应头（${headerList.length}）`" name="h">
            <div v-for="[k, v] in headerList" :key="k" class="ws-header">
              <b>{{ k }}</b>：<span class="ws-break">{{ v }}</span>
            </div>
          </van-collapse-item>
        </van-collapse>
      </div>

      <div class="tool-card">
        <h3 class="tool-card__title">正文</h3>
        <div class="ws-actions">
          <van-button size="small" plain @click="copyBody">复制</van-button>
          <van-button size="small" plain @click="saveBody">保存为文件</van-button>
        </div>
        <pre class="ws-body">{{ shown.text }}</pre>
        <p v-if="shown.truncated" class="tool-hint">只显示前 {{ shown.text.length }} 个字符，共 {{ shown.total }} 个；复制与保存的是完整内容。</p>
        <p v-if="nativeTruncated" class="tool-hint">响应超过 2MB，已被截断。</p>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.ws-btn {
  margin-top: $space-2;
}
.ws-error {
  color: var(--c-error);
}
.ws-line {
  margin: 0 0 $space-1;
  font-size: 14px;
}
.ws-break {
  word-break: break-all;
}
.ws-header {
  padding: 2px 0;
  font-size: 12px;
}
.ws-actions {
  display: flex;
  gap: $space-2;
  margin-bottom: $space-2;
}
.ws-body {
  max-height: 60vh;
  margin: 0;
  overflow: auto;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
