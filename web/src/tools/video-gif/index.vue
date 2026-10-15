<script setup lang="ts">
// 视频转 GIF：原生按帧率取一批 JPEG 帧，页面里用自带编码器合成 GIF，预览后保存
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { extractFrames, mediaInfo, pickVideo, type MediaInfo, type PickedVideo } from '@/native/media'
import { formatBytes } from '@/shared/image-calc'
import { createCanvas, releaseCanvas, saveBlob } from '@/shared/image-io'
import { GifWriter } from '../gif-tool/gif-encoder'
import { formatDuration } from '../video-audio/logic'
import {
  adviceFor, clampDuration, DEFAULT_DURATION_MS, DEFAULT_EDGE, DEFAULT_FPS, delayCs, EDGE_OPTIONS, FPS_MAX, FPS_MIN, frameUrl, gifFileName,
  isCancelled, makePlan, MAX_DURATION_MS, MIN_DURATION_MS, maxStartMs, msgOf, overallPercent,
} from './logic'

/** 无宿主时的提示 */
const TIP_NO_HOST = '视频转 GIF 需要在 App 内使用。'
/** 滑杆步长：起点 0.1 秒 */
const START_STEP_MS = 100
/** 滑杆步长：时长 0.5 秒 */
const DURATION_STEP_MS = 500
/** 兜底尺寸：读不到视频分辨率时按 16:9 估算 */
const FALLBACK_SIZE = { width: 1280, height: 720 }

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 选中的视频 */
const video = ref<PickedVideo | null>(null)
/** 视频信息 */
const info = ref<MediaInfo | null>(null)
/** 起点（毫秒） */
const startMs = ref(0)
/** 时长（毫秒） */
const durationMs = ref(DEFAULT_DURATION_MS)
/** 帧率 */
const fps = ref(DEFAULT_FPS)
/** 最大边 */
const maxEdge = ref<number>(DEFAULT_EDGE)
/** 是否正在转换 */
const running = ref(false)
/** 当前阶段文字 */
const stageText = ref('')
/** 综合进度 */
const percent = ref(0)
/** 结果 GIF */
const gifBlob = ref<Blob | null>(null)
/** 结果预览地址 */
const gifUrl = ref('')
/** 是否正在保存 */
const saving = ref(false)
/** 是否已请求取消 */
let cancelled = false
/** 取帧阶段的取消控制 */
let abort: AbortController | null = null

/** 总时长（毫秒） */
const totalMs = computed(() => info.value?.durationMs ?? video.value?.durationMs ?? 0)
/** 源宽高 */
const srcSize = computed(() => ({
  width: info.value?.width ?? video.value?.width ?? FALLBACK_SIZE.width,
  height: info.value?.height ?? video.value?.height ?? FALLBACK_SIZE.height,
}))
/** 时长滑杆上限 */
const durationMax = computed(() => Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, totalMs.value)))
/** 起点滑杆上限 */
const startMax = computed(() => maxStartMs(totalMs.value, durationMs.value))
/** 当前方案 */
const plan = computed(() =>
  makePlan({
    startMs: startMs.value,
    durationMs: durationMs.value,
    fps: fps.value,
    maxEdge: maxEdge.value,
    totalMs: totalMs.value,
    srcWidth: srcSize.value.width,
    srcHeight: srcSize.value.height,
  }),
)
/** 合理性提示 */
const tips = computed(() => adviceFor(plan.value))
/** 能否开始 */
const canRun = computed(() => !!video.value && totalMs.value > 0 && plan.value.frames > 0 && !running.value)

// 时长变了，起点不能让取帧超出视频结尾
watch(durationMs, () => {
  if (startMs.value > startMax.value) startMs.value = startMax.value
})

/** 释放结果预览地址 */
function revokeGif(): void {
  if (gifUrl.value) URL.revokeObjectURL(gifUrl.value)
  gifUrl.value = ''
  gifBlob.value = null
}

/** 选视频并读取信息 */
async function onPick(): Promise<void> {
  if (running.value) return
  try {
    const v = await pickVideo()
    if (!v) return
    revokeGif()
    video.value = v
    info.value = null
    info.value = await mediaInfo(v.handle)
    startMs.value = 0
    durationMs.value = clampDuration(0, DEFAULT_DURATION_MS, totalMs.value)
  } catch (e) {
    showFailToast(msgOf(e, '读取视频失败'))
  }
}

/** 让出一次事件循环，避免界面卡住 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 取回一帧并缩放到统一尺寸，返回 RGBA 像素 */
async function frameToRgba(path: string, width: number, height: number): Promise<Uint8ClampedArray> {
  const resp = await fetch(frameUrl(path))
  if (!resp.ok) throw new Error('取回视频帧失败')
  const bmp = await createImageBitmap(await resp.blob())
  const canvas = createCanvas(width, height)
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings)
    if (!ctx) throw new Error('当前环境不支持画布')
    ctx.drawImage(bmp, 0, 0, width, height)
    return ctx.getImageData(0, 0, width, height).data
  } finally {
    bmp.close()
    releaseCanvas(canvas)
  }
}

/** 开始转换：取帧 → 逐帧编码 */
async function onConvert(): Promise<void> {
  if (!video.value || !canRun.value) return
  running.value = true
  cancelled = false
  revokeGif()
  percent.value = 0
  stageText.value = '正在取帧…'
  abort = new AbortController()
  try {
    const r = await extractFrames(
      video.value.handle,
      { startMs: startMs.value, durationMs: durationMs.value, fps: fps.value, maxEdge: maxEdge.value },
      { signal: abort.signal, onProgress: (p) => (percent.value = overallPercent('capture', p.done, p.total)) },
    )
    abort = null
    const writer = new GifWriter({ width: r.width, height: r.height, loop: 0 })
    const delay = delayCs(fps.value)
    for (let i = 0; i < r.frames.length; i++) {
      if (cancelled) throw Object.assign(new Error('已取消'), { code: 'CANCELLED' })
      stageText.value = `正在合成 GIF（${i + 1}/${r.frames.length}）`
      writer.addFrame(await frameToRgba(r.frames[i].path, r.width, r.height), delay)
      percent.value = overallPercent('encode', i + 1, r.frames.length)
      await yieldToUi()
    }
    const blob = new Blob([writer.finish() as BlobPart], { type: 'image/gif' })
    gifBlob.value = blob
    gifUrl.value = URL.createObjectURL(blob)
  } catch (e) {
    if (isCancelled(e)) showToast('已取消')
    else showFailToast(msgOf(e, '转换失败'))
  } finally {
    running.value = false
    abort = null
    stageText.value = ''
  }
}

/** 取消转换 */
function onCancel(): void {
  cancelled = true
  abort?.abort()
}

/** 保存 GIF */
async function onSave(): Promise<void> {
  if (!gifBlob.value || !video.value || saving.value) return
  saving.value = true
  try {
    const res = await saveBlob(gifBlob.value, gifFileName(video.value.name))
    showSuccessToast(res.mode === 'native' ? '已保存到相册' : '已开始下载')
  } catch (e) {
    showFailToast(msgOf(e, '保存失败'))
  } finally {
    saving.value = false
  }
}

onBeforeUnmount(() => {
  onCancel()
  revokeGif()
})
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrapable :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>

    <template v-else>
      <div class="tool-card">
        <div class="tool-card__title">1. 选择视频</div>
        <van-button block round plain type="primary" :disabled="running" @click="onPick">{{ video ? '换一个视频' : '选择视频' }}</van-button>
        <template v-if="video">
          <p class="vg-name">{{ video.name }}</p>
          <p class="tool-hint">
            {{ formatBytes(video.size) }}<template v-if="totalMs > 0"> · {{ formatDuration(totalMs) }}</template
            ><template v-if="info?.width && info?.height"> · {{ info.width }}×{{ info.height }}</template>
          </p>
        </template>
      </div>

      <div v-if="video && info && totalMs > 0" class="tool-card">
        <div class="tool-card__title">2. 调整参数</div>

        <div class="vg-label">起点：{{ (startMs / 1000).toFixed(1) }} 秒</div>
        <div class="vg-slider">
          <van-slider v-model="startMs" :min="0" :max="Math.max(START_STEP_MS, startMax)" :step="START_STEP_MS" :disabled="running || startMax <= 0" />
        </div>

        <div class="vg-label">时长：{{ (durationMs / 1000).toFixed(1) }} 秒（最长 15 秒）</div>
        <div class="vg-slider">
          <van-slider v-model="durationMs" :min="MIN_DURATION_MS" :max="durationMax" :step="DURATION_STEP_MS" :disabled="running || durationMax <= MIN_DURATION_MS" />
        </div>

        <div class="vg-label">帧率：{{ fps }} 帧/秒</div>
        <div class="vg-slider">
          <van-slider v-model="fps" :min="FPS_MIN" :max="FPS_MAX" :step="1" :disabled="running" />
        </div>

        <div class="vg-label">最大边</div>
        <div class="vg-row">
          <van-button v-for="e in EDGE_OPTIONS" :key="e" size="small" round :type="maxEdge === e ? 'primary' : 'default'" :disabled="running" @click="maxEdge = e">
            {{ e }}
          </van-button>
        </div>

        <p class="tool-hint vg-plan">
          共 {{ plan.frames }} 帧，{{ plan.width }}×{{ plan.height }}，预计 GIF 约 {{ formatBytes(plan.bytes) }}（估算，实际可能相差一倍）
        </p>
        <p v-for="t in tips" :key="t" class="vg-tip">{{ t }}</p>

        <van-button v-if="!running" block round type="primary" class="vg-go" :disabled="!canRun" @click="onConvert">开始转换</van-button>
        <div v-else class="vg-running">
          <div class="vg-running__main">
            <div class="vg-running__text">{{ stageText }}</div>
            <van-progress :percentage="percent" stroke-width="8" />
          </div>
          <van-button size="small" plain @click="onCancel">取消</van-button>
        </div>
      </div>

      <div v-if="gifBlob" class="tool-card">
        <div class="tool-card__title">3. 预览与保存</div>
        <div class="vg-preview"><img :src="gifUrl" alt="GIF 预览" /></div>
        <p class="tool-hint">{{ formatBytes(gifBlob.size) }} · {{ plan.width }}×{{ plan.height }}</p>
        <van-button block round type="primary" :disabled="saving" @click="onSave">保存 GIF</van-button>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
/* 文件名，过长省略 */
.vg-name {
  margin: $space-3 0 $space-1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--c-text);
}

/* 参数小标题 */
.vg-label {
  margin: $space-3 0 $space-3;
  font-size: 14px;
  color: var(--c-text);
  font-variant-numeric: tabular-nums;
}

/* 滑杆两侧留出把手的位置 */
.vg-slider {
  padding: 0 $space-3;
}

/* 一行按钮，自动换行 */
.vg-row {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

/* 方案说明 */
.vg-plan {
  margin: $space-4 0 $space-1;
}

/* 合理性提示 */
.vg-tip {
  margin: $space-1 0 0;
  font-size: 13px;
  color: var(--c-warn-text);
}

/* 开始按钮 */
.vg-go {
  margin-top: $space-4;
}

/* 进度行 */
.vg-running {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-top: $space-4;
}

/* 进度文字与条 */
.vg-running__main {
  flex: 1;
  min-width: 0;
}

/* 阶段文字 */
.vg-running__text {
  margin-bottom: $space-2;
  font-size: 13px;
  color: var(--c-text-muted);
}

/* 预览图居中 */
.vg-preview {
  display: flex;
  justify-content: center;
  padding: $space-2 0;

  img {
    max-width: 100%;
    border-radius: $radius;
  }
}
</style>
