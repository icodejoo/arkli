<script setup lang="ts">
// 视频提取音频：选视频，可裁起止时间，把 AAC 音轨直接封装成 .m4a（不重编码，音质无损）
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { extractAudio, mediaInfo, pickVideo, saveCachedFile, type ExtractedAudio, type MediaInfo, type PickedVideo } from '@/native/media'
import { share } from '@/native/system'
import { formatBytes } from '@/shared/image-calc'
import {
  AUDIO_OUT_MIME, checkAudio, formatDuration, isCancelled, msgOf, normalizeRange, percentOf, rangeLabel, sliderStep, toRequest, type Range,
} from './logic'

/** 无宿主时的提示 */
const TIP_NO_HOST = '视频提取音频需要在 App 内使用。'
/** 只支持 AAC 的说明 */
const TIP_AAC = '目前只能提取 AAC 编码的音轨（手机拍摄和大多数 MP4 都是），直接封装成 .m4a，不重新编码。'

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 选中的视频 */
const video = ref<PickedVideo | null>(null)
/** 视频信息 */
const info = ref<MediaInfo | null>(null)
/** 滑杆值：起止毫秒 */
const sliderValue = ref<[number, number]>([0, 0])
/** 是否正在提取 */
const running = ref(false)
/** 提取进度百分比 */
const percent = ref(0)
/** 提取结果 */
const result = ref<ExtractedAudio | null>(null)
/** 是否正在保存或分享 */
const saving = ref(false)
/** 取消控制 */
let abort: AbortController | null = null

/** 总时长（毫秒） */
const totalMs = computed(() => info.value?.durationMs ?? video.value?.durationMs ?? 0)
/** 滑杆步长 */
const step = computed(() => sliderStep(totalMs.value))
/** 规整后的起止 */
const range = computed<Range>(() => normalizeRange(sliderValue.value, totalMs.value))
/** 音轨检查 */
const audio = computed(() => (info.value ? checkAudio(info.value) : null))
/** 能否开始提取 */
const canRun = computed(() => !!video.value && !!audio.value?.ok && totalMs.value > 0 && !running.value)
/** 视频概要 */
const summary = computed(() => {
  if (!video.value) return ''
  const parts = [formatBytes(video.value.size)]
  if (totalMs.value > 0) parts.push(formatDuration(totalMs.value))
  const w = info.value?.width ?? video.value.width
  const h = info.value?.height ?? video.value.height
  if (w && h) parts.push(`${w}×${h}`)
  return parts.join(' · ')
})

/** 选视频并读取信息 */
async function onPick(): Promise<void> {
  if (running.value) return
  try {
    const v = await pickVideo()
    if (!v) return
    video.value = v
    result.value = null
    info.value = null
    info.value = await mediaInfo(v.handle)
    sliderValue.value = [0, totalMs.value]
  } catch (e) {
    showFailToast(msgOf(e, '读取视频失败'))
  }
}

/** 滑杆变化后把值收拢成合法区间 */
function onSlide(v: [number, number]): void {
  const r = normalizeRange(v, totalMs.value)
  sliderValue.value = [r.startMs, r.endMs]
}

/** 开始提取 */
async function onExtract(): Promise<void> {
  if (!video.value || !canRun.value) return
  running.value = true
  percent.value = 0
  result.value = null
  abort = new AbortController()
  try {
    result.value = await extractAudio(video.value.handle, toRequest(range.value, totalMs.value), {
      signal: abort.signal,
      onProgress: (p) => (percent.value = percentOf(p)),
    })
  } catch (e) {
    if (isCancelled(e)) showToast('已取消')
    else showFailToast(msgOf(e, '提取失败'))
  } finally {
    running.value = false
    abort = null
  }
}

/** 取消提取 */
function onCancel(): void {
  abort?.abort()
}

/** 保存到手机的音乐目录 */
async function onSave(): Promise<void> {
  const r = result.value
  if (!r || saving.value) return
  saving.value = true
  try {
    const saved = await saveCachedFile(r.path, r.name, AUDIO_OUT_MIME)
    showSuccessToast(`已保存到 ${saved.dir}`)
  } catch (e) {
    showFailToast(msgOf(e, '保存失败'))
  } finally {
    saving.value = false
  }
}

/** 分享音频文件 */
async function onShare(): Promise<void> {
  const r = result.value
  if (!r || saving.value) return
  saving.value = true
  try {
    await share({ path: r.path, mime: AUDIO_OUT_MIME, title: r.name })
  } catch (e) {
    showFailToast(msgOf(e, '分享失败'))
  } finally {
    saving.value = false
  }
}

onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrapable :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>

    <template v-else>
      <tool-group>
        <div class="tool-group__title">1. 选择视频</div>
        <p v-if="!video" class="tool-hint">点底部「相册」选一个视频。</p>
        <template v-else>
          <p class="va-name">{{ video.name }}</p>
          <p class="tool-hint">{{ summary }}</p>
          <p v-if="audio" class="va-audio" :class="{ 'va-audio--bad': !audio.ok }">
            {{ audio.ok ? `音轨：${audio.text}` : audio.text }}
          </p>
        </template>
        <p class="tool-hint">{{ TIP_AAC }}</p>
      </tool-group>

      <tool-group v-if="video && info && audio?.ok && totalMs> 0" title="2. 截取时间段（默认整段）">
        <p class="va-range">{{ rangeLabel(range) }}</p>
        <div class="va-slider">
          <van-slider v-model="sliderValue" range :min="0" :max="totalMs" :step="step" :disabled="running" @update:model-value="onSlide" />
        </div>
        <div v-if="running" class="va-running">
          <van-progress :percentage="percent" stroke-width="8" />
        </div>
      </tool-group>

      <tool-group v-if="result">
        <div class="tool-group__title">3. 提取完成</div>
        <p class="va-name">{{ result.name }}</p>
        <p class="tool-hint">{{ formatBytes(result.bytes) }} · {{ formatDuration(result.durationMs) }} · m4a（AAC）</p>
      </tool-group>
    </template>

    <!-- 底部动作栏：相册选视频，保存 / 分享提取结果，主按钮提取音频（提取中变成取消） -->
    <bottom-actions :actions="{ save: { disabled: !result || saving, text: '保存到手机' }, share: { disabled: !result || saving } }" v-if="hosted" album main :main-text="running ? '取消' : '提取音频'" :main-type="running ? 'danger' : 'primary'" :disabled="{ album: running, main: !running && !canRun }" @album="onPick" @main="running ? onCancel() : onExtract()" @save="onSave" @share="onShare" />
  </div>
</template>

<style lang="scss" scoped>
/* 文件名，过长省略 */
.va-name {
  margin: $space-3 0 $space-1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--c-text);
}

/* 音轨说明 */
.va-audio {
  margin: $space-1 0 $space-2;
  font-size: 13px;
  color: var(--c-text-muted);

  /* 不能提取时标红 */
  &--bad {
    color: var(--c-error);
  }
}

/* 当前区间文字 */
.va-range {
  margin: 0 0 $space-4;
  font-size: 15px;
  color: var(--c-text);
  font-variant-numeric: tabular-nums;
}

/* 滑杆两侧留出把手的位置 */
.va-slider {
  padding: 0 $space-3;
}

/* 进度行 */
.va-running {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-top: $space-4;

  .van-progress {
    flex: 1;
  }
}
</style>
