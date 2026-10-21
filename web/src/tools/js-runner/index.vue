<script setup lang="ts">
// JS 运行器：代码放进 Web Worker 执行，捕获 console 输出，超时强杀
import BottomActions from '@/shared/BottomActions.vue'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { computed, onBeforeUnmount, ref } from 'vue'
import { showToast } from 'vant'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { oneOf } from '@/shared/persistValidators'
import { DEFAULT_TIMEOUT_MS, runCode, type LogEntry, type RunHandle, type RunStatus } from './logic'

/** 旧版本地保存代码用的 key（仅用于迁移） */
const STORAGE_KEY = 'arkli.js-runner.code'
/** 可选超时（秒） */
const TIMEOUT_OPTIONS = [3, 5, 10, 30]
/** 超时选择器选项（值为秒数） */
const TIMEOUT_CHOICES: readonly CellOption[] = TIMEOUT_OPTIONS.map((s) => ({ value: s, label: `${s} 秒` }))
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

/** 本工具的持久缓存 */
const store = createToolStorage('js-runner')
// 旧版把代码直接存在 localStorage 的单独键里，一次性迁入（原文即代码，不做 JSON 解析）
store.adoptLegacy(STORAGE_KEY, 'code', (raw) => raw)
/** 代码内容，改动后自动记住 */
const code = usePersistedRef(store, 'code', SAMPLE, (v) => typeof v === 'string')
/** 超时秒数 */
const timeoutSec = usePersistedRef(store, 'timeoutSec', DEFAULT_TIMEOUT_MS / MS_PER_SEC, oneOf(TIMEOUT_OPTIONS))
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
    <tool-group title="代码">
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
      <cell-picker :model-value="timeoutSec" title="超时" :options="TIMEOUT_CHOICES" :disabled="running" @update:model-value="timeoutSec = $event as number" />
      <div class="jr-actions">
        <van-button size="small" plain :disabled="!logs.length && !last" @click="clear">清空输出</van-button>
      </div>
      <p class="tool-hint jr-note">
        代码只在本机的 Worker 里运行，不会上传。没有 window、document，也碰不到 App 内部接口。
      </p>
    </tool-group>

    <tool-group title="输出（最新在上）">
      <p v-if="statusText" class="tool-hint jr-status" :class="{ 'jr-status--bad': last && last.status !== 'ok' }">
        {{ statusText }}
      </p>
      <p v-if="!logs.length && !last" class="tool-hint">还没有输出，点“运行”试试。</p>
      <div v-for="(l, i) in shownLogs" :key="logs.length - i" class="jr-line" :class="`jr-line--${l.level}`">
        <span class="jr-line__t">{{ l.t }}ms</span>
        <pre class="jr-line__text">{{ l.level === 'result' ? '← ' + l.text : l.text }}</pre>
      </div>
    </tool-group>

    <!-- 底部动作栏：主按钮运行（运行中变成停止） -->
    <bottom-actions :main-loading="running" main :main-text="running ? '停止' : '运行'" :main-type="running ? 'danger' : 'primary'" @main="running ? stop() : run()" />
  </div>
</template>

<style lang="scss" scoped>
.jr-code :deep(textarea) {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
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
