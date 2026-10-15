<script setup lang="ts">
// 噪音测量：用麦克风估算环境噪音。数值没有经过校准，仅供参考；可用校准偏移对齐一台已知的声级计
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { showFailToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { onNoiseSample, startNoise, stopNoise } from '@/native/noise'
import { openSettings, requestPermission } from '@/native/system'
import {
  applyOffset, CHART_WINDOW_MS, chartPoints, clampOffset, formatDb, gaugeFraction, GAUGE_RANGE, loadOffset, noiseLevel, OFFSET_RANGE,
  RingBuffer, ringCapacity, saveOffset, SAMPLE_INTERVAL_MS, StatsTracker, type NoiseStatsView, type Tone,
} from './logic'

/** 无宿主时的提示 */
const TIP_NO_HOST = '噪音测量需要在 App 内使用，浏览器里没有原生麦克风通道。'
/** 精度声明，页面显著位置展示 */
const TIP_UNCALIBRATED = '手机麦克风未经校准，数值仅供参考，不能当作专业声级计。'
/** 权限被拒的提示 */
const TIP_DENIED = '没有麦克风权限，无法测量。请在系统设置里允许「麦克风」后重试。'
/** 色调对应的主题色变量 */
const TONE_COLOR: Record<Tone, string> = { ok: 'var(--c-ok)', warn: 'var(--c-warn-text)', bad: 'var(--c-error)' }
/** 折线图的刻度线（dB） */
const GRID_DB = [40, 60, 80, 100]
/** 折线图高度（CSS 像素） */
const CHART_HEIGHT = 140

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 是否正在测量 */
const running = ref(false)
/** 启动中 */
const starting = ref(false)
/** 权限被拒 */
const denied = ref(false)
/** 校准偏移（dB） */
const offset = ref(loadOffset())
/** 原生给的最新原始值（未叠偏移） */
const rawDb = ref<number | null>(null)
/** 原生给的最新峰值（未叠偏移） */
const rawPeak = ref<number | null>(null)
/** 最大 / 最小 / 平均（显示值，已叠偏移） */
const stats = ref<NoiseStatsView>({ min: null, max: null, avg: null, count: 0 })

/** 折线图用的环形缓冲：存原始值，偏移变化时折线能跟着变 */
const ring = new RingBuffer(ringCapacity(SAMPLE_INTERVAL_MS, CHART_WINDOW_MS))
/** 统计累计器：存原始值，换算在读出时做 */
const tracker = new StatsTracker()
/** 画布元素 */
const canvas = ref<HTMLCanvasElement | null>(null)
/** 取消订阅 */
let off: (() => void) | null = null
/** 已排队的重绘 */
let raf = 0

/** 当前显示值 */
const shown = computed(() => (rawDb.value == null ? null : applyOffset(rawDb.value, offset.value)))
/** 峰值显示值 */
const shownPeak = computed(() => (rawPeak.value == null ? null : applyOffset(rawPeak.value, offset.value)))
/** 当前等级，没数据时为 null */
const level = computed(() => (shown.value == null ? null : noiseLevel(shown.value)))
/** 条形填充比例 */
const fill = computed(() => (shown.value == null ? 0 : gaugeFraction(shown.value)))
/** 主色 */
const color = computed(() => (level.value ? TONE_COLOR[level.value.tone] : 'var(--c-text-muted)'))
/** 统计的显示值 */
const statsShown = computed(() => {
  const s = stats.value
  const f = (v: number | null) => (v == null ? null : applyOffset(v, offset.value))
  return { min: f(s.min), max: f(s.max), avg: f(s.avg) }
})

/** 收到一个采样：存原始值，排一次重绘 */
function onSample(s: { db: number; peakDb: number }): void {
  rawDb.value = s.db
  rawPeak.value = s.peakDb
  ring.push(s.db)
  tracker.add(s.db)
  stats.value = tracker.view()
  scheduleDraw()
}

/** 下一帧重绘折线图 */
function scheduleDraw(): void {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    draw()
  })
}

/** 取 CSS 变量的当前值 */
function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback
}

/** 画近 60 秒折线与刻度 */
function draw(): void {
  const cv = canvas.value
  if (!cv) return
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth
  const h = CHART_HEIGHT
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
  }
  const g = cv.getContext('2d')
  if (!g) return
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  g.font = '10px sans-serif'
  g.lineWidth = 1
  g.strokeStyle = cssVar(cv, '--c-border', '#e6e8ec')
  g.fillStyle = cssVar(cv, '--c-text-muted', '#6b7280')
  for (const db of GRID_DB) {
    const y = h * (1 - gaugeFraction(db))
    g.beginPath()
    g.moveTo(0, y)
    g.lineTo(w, y)
    g.stroke()
    g.fillText(String(db), 2, y - 2)
  }
  const values = ring.values().map((v) => applyOffset(v, offset.value))
  if (values.length < 2) return
  g.strokeStyle = cssVar(cv, '--c-primary', '#3b6cf6')
  g.lineWidth = 2
  g.lineJoin = 'round'
  g.beginPath()
  chartPoints(values, ring.capacity, w, h).forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)))
  g.stroke()
}

/** 开始测量：先要麦克风权限，再启动原生采集 */
async function onStart(): Promise<void> {
  if (running.value || starting.value) return
  starting.value = true
  denied.value = false
  try {
    const perm = await requestPermission('microphone')
    if (!perm.granted) {
      denied.value = true
      return
    }
    off?.()
    off = onNoiseSample(onSample)
    await startNoise(SAMPLE_INTERVAL_MS)
    running.value = true
  } catch (e) {
    off?.()
    off = null
    const err = e as { code?: string; message?: string }
    if (err.code === 'PERMISSION_DENIED') denied.value = true
    else showFailToast(err.message || '启动失败')
  } finally {
    starting.value = false
  }
}

/** 停止测量并释放麦克风 */
async function onStop(): Promise<void> {
  off?.()
  off = null
  running.value = false
  try {
    await stopNoise()
  } catch (e) {
    showFailToast((e as { message?: string }).message || '停止失败')
  }
}

/** 清零统计与折线，保持测量状态 */
function onReset(): void {
  ring.clear()
  tracker.reset()
  stats.value = tracker.view()
  rawDb.value = null
  rawPeak.value = null
  scheduleDraw()
}

/** 去系统设置里开权限 */
async function onOpenSettings(): Promise<void> {
  try {
    await openSettings('app')
  } catch (e) {
    showFailToast((e as { message?: string }).message || '打不开系统设置')
  }
}

/** 滑杆调整校准：夹取、保存、重绘 */
function onOffset(v: number): void {
  offset.value = clampOffset(v)
  saveOffset(offset.value)
  scheduleDraw()
}

watch(canvas, scheduleDraw)
onMounted(scheduleDraw)
onBeforeUnmount(() => {
  off?.()
  off = null
  if (raf) cancelAnimationFrame(raf)
  if (running.value && hosted) void stopNoise().catch(() => undefined)
})
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrapable :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>
    <van-notice-bar wrapable :scrollable="false" color="var(--c-warn-text)" background="var(--c-warn-bg)" left-icon="warning-o">{{ TIP_UNCALIBRATED }}</van-notice-bar>

    <div class="tool-card nm-main">
      <div class="nm-db" :style="{ color }">{{ formatDb(shown) }}<span class="nm-unit">dB</span></div>
      <div class="nm-level" :style="{ color }">{{ level ? level.label : running ? '测量中…' : '点击下方开始' }}</div>
      <div class="nm-bar" role="presentation">
        <div class="nm-bar__fill" :style="{ width: `${fill * 100}%`, background: color }"></div>
      </div>
      <div class="nm-scale"><span>{{ GAUGE_RANGE.min }}</span><span>70</span><span>{{ GAUGE_RANGE.max }}</span></div>
      <div class="nm-stats">
        <div><div class="nm-stats__v">{{ formatDb(statsShown.min) }}</div><div class="nm-stats__k">最小</div></div>
        <div><div class="nm-stats__v">{{ formatDb(statsShown.avg) }}</div><div class="nm-stats__k">平均</div></div>
        <div><div class="nm-stats__v">{{ formatDb(statsShown.max) }}</div><div class="nm-stats__k">最大</div></div>
        <div><div class="nm-stats__v">{{ formatDb(shownPeak) }}</div><div class="nm-stats__k">瞬时峰值</div></div>
      </div>
      <div class="nm-actions">
        <van-button v-if="!running" type="primary" round block :loading="starting" :disabled="!hosted" @click="onStart">开始测量</van-button>
        <van-button v-else type="danger" round block @click="onStop">停止</van-button>
        <van-button plain round :disabled="!stats.count" @click="onReset">清零</van-button>
      </div>
      <div v-if="denied" class="nm-denied">
        <p>{{ TIP_DENIED }}</p>
        <van-button size="small" plain round @click="onOpenSettings">打开系统设置</van-button>
      </div>
    </div>

    <div class="tool-card">
      <div class="tool-card__title">近 60 秒</div>
      <canvas ref="canvas" class="nm-chart" :style="{ height: `${CHART_HEIGHT}px` }"></canvas>
    </div>

    <div class="tool-card">
      <div class="tool-card__title">校准偏移：{{ offset > 0 ? '+' : '' }}{{ offset }} dB</div>
      <van-slider :model-value="offset" :min="OFFSET_RANGE.min" :max="OFFSET_RANGE.max" :step="0.5" @update:model-value="onOffset" />
      <p class="tool-hint">拿一台声级计或可信的 App 对照，把读数调到一致。偏移只影响显示，会记住。</p>
      <p class="tool-hint">参考：&lt;30 很安静，30~50 安静，50~70 一般，70~85 嘈杂，&gt;85 长时间会伤听力。</p>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 主读数卡片居中 */
.nm-main {
  text-align: center;
}

/* 大号分贝读数 */
.nm-db {
  font-size: 64px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

/* 单位 */
.nm-unit {
  margin-left: 4px;
  font-size: 20px;
  font-weight: 500;
}

/* 等级文字 */
.nm-level {
  margin: $space-1 0 $space-3;
  font-size: 18px;
  font-weight: 600;
}

/* 条形底槽 */
.nm-bar {
  height: 12px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--c-surface-active);
}

/* 条形填充，颜色随等级 */
.nm-bar__fill {
  height: 100%;
  border-radius: 6px;
  transition: width 0.1s linear;
}

/* 条形刻度 */
.nm-scale {
  display: flex;
  justify-content: space-between;
  margin-top: 2px;
  font-size: 11px;
  color: var(--c-text-muted);
}

/* 四项统计 */
.nm-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: $space-2;
  margin: $space-4 0;
}

/* 统计数值 */
.nm-stats__v {
  font-size: 18px;
  font-weight: 600;
  color: var(--c-text);
  font-variant-numeric: tabular-nums;
}

/* 统计名称 */
.nm-stats__k {
  font-size: 12px;
  color: var(--c-text-muted);
}

/* 开始 / 清零按钮并排 */
.nm-actions {
  display: flex;
  gap: $space-2;
}

/* 权限被拒的提示 */
.nm-denied {
  margin-top: $space-3;
  font-size: 13px;
  color: var(--c-error);
}

/* 折线图占满宽度 */
.nm-chart {
  display: block;
  width: 100%;
}
</style>
