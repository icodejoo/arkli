<script setup lang="ts">
// 网速测试：TCP 延迟 + 下行速率，需要用户点「开始」才会消耗流量
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { isNativeAvailable } from '@/native/bridge'
import { netSpeed } from '@/native/net'
import {
  formatMBps, formatMbps, formatMs, formatTime, latencyStats, LATENCY_HOST, LATENCY_PORT, LATENCY_TIMES, loadHistory, measureLatency,
  pushHistory, saveHistory, SPEED_DURATION_MS, SPEED_MAX_BYTES, SPEED_URL, type HistoryEntry, type LatencyStats,
} from './logic'

/** 进度条刷新间隔（毫秒） */
const TICK_MS = 200
/** 进度条在结果出来之前最多走到的百分比 */
const PROGRESS_CAP = 99

/** 阶段：空闲 / 测延迟 / 测下行 */
type Phase = 'idle' | 'latency' | 'download'

/** 是否在 App 内 */
const inApp = isNativeAvailable()
/** 当前阶段 */
const phase = ref<Phase>('idle')
/** 已完成的延迟样本数 */
const sampleDone = ref(0)
/** 延迟统计 */
const latency = ref<LatencyStats | null>(null)
/** 下行速率（bps） */
const bps = ref<number | null>(null)
/** 下行实际流量（字节） */
const bytes = ref(0)
/** 下行进度百分比（按时间估算，原生只在结束时返回） */
const progress = ref(0)
/** 错误提示 */
const error = ref('')
/** 历史记录 */
const history = ref<HistoryEntry[]>(loadHistory())
/** 当前测试的取消器 */
let ac: AbortController | null = null
/** 进度定时器 */
let timer: ReturnType<typeof setInterval> | undefined

/** 是否正在测试 */
const running = computed(() => phase.value !== 'idle')
/** 下行流量说明 */
const maxMb = Math.round(SPEED_MAX_BYTES / 1_000_000)

/** 停掉进度定时器 */
function stopTimer(): void {
  clearInterval(timer)
  timer = undefined
}

/** 开始测试；进行中再点等于取消 */
async function start(): Promise<void> {
  if (running.value) {
    ac?.abort()
    return
  }
  error.value = ''
  latency.value = null
  bps.value = null
  bytes.value = 0
  sampleDone.value = 0
  progress.value = 0
  const mine = new AbortController()
  ac = mine
  try {
    phase.value = 'latency'
    const samples = await measureLatency(LATENCY_HOST, LATENCY_PORT, LATENCY_TIMES, undefined, {
      signal: mine.signal,
      onSample: () => ac === mine && (sampleDone.value += 1),
    })
    if (ac !== mine) return
    latency.value = latencyStats(samples)

    phase.value = 'download'
    const t0 = Date.now()
    timer = setInterval(() => (progress.value = Math.min(PROGRESS_CAP, Math.round(((Date.now() - t0) / SPEED_DURATION_MS) * 100))), TICK_MS)
    let result: { bps: number; bytes: number } | null = null
    try {
      result = await netSpeed({ url: SPEED_URL, maxBytes: SPEED_MAX_BYTES, durationMs: SPEED_DURATION_MS }, undefined, mine.signal)
    } catch (e) {
      if (mine.signal.aborted) throw e
      if (ac === mine) error.value = `下行测速失败：${(e as { message?: string }).message || '未知错误'}`
    }
    if (ac !== mine) return
    if (result) {
      bps.value = result.bps
      bytes.value = result.bytes
      progress.value = 100
    }
    const stats = latency.value
    history.value = pushHistory(history.value, { ts: Date.now(), latencyMin: stats.min, latencyAvg: stats.avg, jitter: stats.jitter, bps: result ? result.bps : null })
    saveHistory(history.value)
  } catch (e) {
    if (ac === mine) error.value = mine.signal.aborted ? '已取消' : (e as { message?: string }).message || '测试失败'
  } finally {
    if (ac === mine) {
      stopTimer()
      phase.value = 'idle'
      ac = null
    }
  }
}

onBeforeUnmount(() => {
  const cur = ac
  ac = null
  stopTimer()
  cur?.abort()
})
</script>

<template>
  <div class="tool-page">
    <tool-group v-if="!inApp">
      <p class="tool-hint">需要在 App 内使用：测速由 App 原生发出，浏览器里没法直接联网。</p>
    </tool-group>

    <tool-group title="开始前请注意">
      <p class="tool-hint">下行测速最多下载约 {{ maxMb }}MB，用移动数据时请留意流量。点「开始」才会测。</p>
      <p v-if="phase === 'latency'" class="tool-hint">测延迟 {{ sampleDone }}/{{ LATENCY_TIMES }}…</p>
      <p v-else-if="phase === 'download'" class="tool-hint">测下行…</p>
      <van-progress v-if="phase === 'download'" :percentage="progress" stroke-width="6" class="st-progress" />
      <p v-if="error" class="tool-hint st-error">{{ error }}</p>
    </tool-group>

    <tool-group v-if="latency" :title="`延迟（TCP 连接 ${LATENCY_HOST}:${LATENCY_PORT}，${latency.count} 次）`">
      <div v-if="latency.ok" class="st-grid">
        <div><b>{{ formatMs(latency.min) }}</b><span>最小</span></div>
        <div><b>{{ formatMs(latency.avg) }}</b><span>平均</span></div>
        <div><b>{{ formatMs(latency.jitter) }}</b><span>抖动</span></div>
      </div>
      <p v-else class="tool-hint st-error">5 次都没连上，网络可能不通。</p>
      <p v-if="latency.ok && latency.loss > 0" class="tool-hint">有 {{ Math.round(latency.loss * 100) }}% 的连接失败。</p>
    </tool-group>

    <tool-group v-if="bps !== null" title="下行速率">
      <p class="st-big">{{ formatMbps(bps) }}</p>
      <p class="tool-hint">约 {{ formatMBps(bps) }}，本次下载 {{ (bytes / 1_000_000).toFixed(1) }}MB。</p>
    </tool-group>

    <tool-group v-if="history.length" title="最近记录">
      <div v-for="h in history" :key="h.ts" class="st-his">
        <span>{{ formatTime(h.ts) }}</span>
        <span>{{ formatMs(h.latencyAvg) }}</span>
        <span>{{ h.bps === null ? '—' : formatMbps(h.bps) }}</span>
      </div>
    </tool-group>

    <p class="tool-hint st-src">测速数据来自 Cloudflare（speed.cloudflare.com），结果受网络与服务器影响，仅供参考。</p>

    <!-- 底部动作栏：主按钮开始测速（测速中变成取消） -->
    <bottom-actions main :main-text="phase === 'latency' || phase === 'download' ? '取消' : '开始测速'" :main-type="phase === 'latency' || phase === 'download' ? 'danger' : 'primary'" :disabled="{ main: !inApp }" @main="start" />
  </div>
</template>

<style lang="scss" scoped>
.st-progress {
  margin-top: $space-2;
}
.st-error {
  color: var(--c-error);
}
.st-grid {
  display: flex;
  text-align: center;

  > div {
    flex: 1;
  }
  b {
    display: block;
    font-size: 18px;
  }
  span {
    font-size: 12px;
    color: var(--c-text-muted);
  }
}
.st-big {
  margin: 0;
  font-size: 28px;
  font-weight: 600;
  color: var(--c-primary);
}
.st-his {
  display: flex;
  justify-content: space-between;
  padding: $space-1 0;
  font-size: 13px;
}
.st-src {
  padding: 0 $space-2;
}
</style>
