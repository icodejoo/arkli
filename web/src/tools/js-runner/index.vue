<script setup lang="ts">
// JS 运行器：代码放进 Web Worker 执行，捕获 console 输出，超时强杀
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { showToast } from 'vant'
import { DEFAULT_TIMEOUT_MS, runCode, type LogEntry, type RunHandle, type RunStatus } from './logic'

/** 本地保存代码用的 key */
const STORAGE_KEY = 'arkli.js-runner.code'
/** 可选超时（秒） */
const TIMEOUT_OPTIONS = [3, 5, 10, 30]
/** 毫秒换算 */
const MS_PER_SEC = 1000
/** 示例代码 */
const SAMPLE = `// 支持顶层 await；setTimeout 之类的异步要自己等待
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
console.log('开始')
await sleep(300)
console.log([1, 2, 3].map((n) => n * 2))
console.log({ name: 'arkli', ok: true })
`

/** 读取上次保存的代码，不可用时给示例 */
function loadCode(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? SAMPLE
  } catch {
    return SAMPLE
  }
}

/** 代码内容 */
const code = ref(loadCode())
/** 超时秒数 */
const timeoutSec = ref(DEFAULT_TIMEOUT_MS / MS_PER_SEC)
/** 输出（按产生顺序，显示时倒序） */
const logs = ref<LogEntry[]>([])
/** 是否正在运行 */
const running = ref(false)
/** 最近一次的状态与说明 */
const last = ref<{ status: RunStatus; error?: string; ms: number } | null>(null)
/** 当前运行句柄，卸载时用来终止 */
let handle: RunHandle | null = null

/** 倒序后的输出，最新的在最上面 */
const shownLogs = computed(() => logs.value.slice().reverse())
/** 状态栏文字 */
const statusText = computed(() => {
  const s = last.value
  if (!s) return ''
  const map: Record<RunStatus, string> = { ok: '执行完成', error: '执行出错', timeout: '执行超时', cancelled: '已终止' }
  return `${map[s.status]} · ${s.ms} ms${s.error ? ' · ' + s.error : ''}`
})

// 代码变化后存起来，下次打开还在
watch(code, (v) => {
  try {
    localStorage.setItem(STORAGE_KEY, v)
  } catch {
    // 存储不可用就算了
  }
})

onBeforeUnmount(() => handle?.cancel())

/** 开始运行 */
async function run(): Promise<void> {
  if (running.value) return
  running.value = true
  last.value = null
  const h = runCode(code.value, {
    timeoutMs: timeoutSec.value * MS_PER_SEC,
    onLog: (e) => logs.value.push(e),
  })
  handle = h
  const r = await h.result
  if (handle !== h) return
  handle = null
  running.value = false
  last.value = { status: r.status, error: r.error, ms: r.ms }
  if (r.status === 'timeout') showToast('执行超时，已强制终止')
}

/** 手动停止 */
function stop(): void {
  handle?.cancel()
}

/** 清空输出 */
function clear(): void {
  logs.value = []
  last.value = null
}
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">代码</h3>
      <van-field
        v-model="code"
        type="textarea"
        rows="10"
        autosize
        class="jr-code"
        placeholder="在这里写 JavaScript"
        :spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
      />
      <div class="jr-opts">
        <span class="tool-hint">超时</span>
        <van-radio-group v-model="timeoutSec" direction="horizontal" :disabled="running">
          <van-radio v-for="s in TIMEOUT_OPTIONS" :key="s" :name="s">{{ s }} 秒</van-radio>
        </van-radio-group>
      </div>
      <div class="jr-actions">
        <van-button v-if="!running" type="primary" size="small" @click="run">运行</van-button>
        <van-button v-else type="danger" size="small" @click="stop">停止</van-button>
        <van-button size="small" plain :disabled="!logs.length && !last" @click="clear">清空输出</van-button>
      </div>
      <p class="tool-hint jr-note">
        代码只在本机的 Worker 里运行，不会上传。没有 window、document，也碰不到 App 内部接口。
      </p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">输出（最新在上）</h3>
      <p v-if="statusText" class="tool-hint jr-status" :class="{ 'jr-status--bad': last && last.status !== 'ok' }">
        {{ statusText }}
      </p>
      <p v-if="!logs.length && !last" class="tool-hint">还没有输出，点“运行”试试。</p>
      <div v-for="(l, i) in shownLogs" :key="logs.length - i" class="jr-line" :class="`jr-line--${l.level}`">
        <span class="jr-line__t">{{ l.t }}ms</span>
        <pre class="jr-line__text">{{ l.level === 'result' ? '← ' + l.text : l.text }}</pre>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.jr-code :deep(textarea) {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
}
.jr-opts {
  display: flex;
  align-items: center;
  gap: $space-2;
  margin: $space-2 0;
  flex-wrap: wrap;
}
.jr-actions {
  display: flex;
  gap: $space-2;
}
.jr-note {
  margin-top: $space-2;
}
.jr-status {
  margin-bottom: $space-2;

  &--bad {
    color: var(--c-error);
  }
}

/* 输出行：左边时间，右边内容，按级别着色 */
.jr-line {
  display: flex;
  gap: $space-2;
  padding: 4px 0;
  border-bottom: 1px solid var(--c-border);

  &--error {
    color: var(--c-error);
  }
  &--warn {
    color: #d48806;
  }
  &--system {
    color: var(--c-text-muted);
  }
  &--result {
    color: var(--van-success-color);
  }
}
.jr-line__t {
  flex: none;
  width: 52px;
  font-size: 11px;
  color: var(--c-text-muted);
}
.jr-line__text {
  flex: 1;
  margin: 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
