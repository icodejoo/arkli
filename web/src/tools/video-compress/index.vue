<script setup lang="ts">
// 视频压缩：选视频，挑一档预设，原生用系统编码器重新编码（只降码率，不改分辨率），音轨原样保留
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { compressVideo, mediaInfo, pickVideo, saveCachedFile, type CompressPreset, type CompressResult, type MediaInfo, type PickedVideo } from '@/native/media'
import { share } from '@/native/system'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { formatBytes } from '@/shared/image-calc'
import { formatDuration, percentOf } from '../video-audio/logic'
import {
  changeText, checkAudioKept, estimateBytes, isCancelled, isNotSmaller, msgOf, NOT_SMALLER_TEXT, preWarning, PRESETS,
} from './logic'

/** 本工具的持久缓存 */
const store = createToolStorage('video-compress')
/** 无宿主时的提示 */
const TIP_NO_HOST = '视频压缩需要在 App 内使用。'
/** 压缩产物 mime */
const VIDEO_OUT_MIME = 'video/mp4'
/** 当前版本限制说明 */
const LIMITS = [
  '当前版本只降低码率，不改分辨率。',
  '若结果比原视频还大，会提示你保留原视频。',
  '压缩用手机自带的编码器，耗时与视频长度相近；过程中请保持页面打开，别切到后台。',
]

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 选中的视频 */
const video = ref<PickedVideo | null>(null)
/** 视频信息 */
const info = ref<MediaInfo | null>(null)
/** 当前预设 */
const preset = usePersistedRef<CompressPreset>(store, 'preset', 'medium', (v) => PRESETS.some((p) => p.key === v))
/** 是否正在压缩 */
const running = ref(false)
/** 进度百分比 */
const percent = ref(0)
/** 压缩结果 */
const result = ref<CompressResult | null>(null)
/** 是否正在保存或分享 */
const saving = ref(false)
/** 取消控制 */
let abort: AbortController | null = null

/** 源体积：优先用原生读到的，其次选择器给的 */
const srcBytes = computed(() => info.value?.sizeBytes ?? video.value?.size ?? 0)
/** 各档预计体积 */
const estimates = computed(() => {
  const i = info.value
  return PRESETS.map((p) => (i ? estimateBytes(i, p.key) : null))
})
/** 当前档预计体积 */
const currentEstimate = computed(() => estimates.value[PRESETS.findIndex((p) => p.key === preset.value)] ?? null)
/** 开始前的预警 */
const warning = computed(() => preWarning(currentEstimate.value, srcBytes.value))
/** 音轨检查 */
const audioCheck = computed(() => (info.value ? checkAudioKept(info.value) : { ok: true, text: '' }))
/** 能否开始 */
const canRun = computed(() => !!video.value && !!info.value && audioCheck.value.ok && !running.value)
/** 结果是否没压小 */
const notSmaller = computed(() => (result.value ? isNotSmaller(result.value) : false))

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
  } catch (e) {
    showFailToast(msgOf(e, '读取视频失败'))
  }
}

/** 开始压缩 */
async function onCompress(): Promise<void> {
  if (!video.value || !canRun.value) return
  running.value = true
  percent.value = 0
  result.value = null
  abort = new AbortController()
  try {
    result.value = await compressVideo(video.value.handle, preset.value, {
      signal: abort.signal,
      onProgress: (p) => (percent.value = percentOf(p)),
    })
  } catch (e) {
    if (isCancelled(e)) showToast('已取消')
    else showFailToast(msgOf(e, '压缩失败'))
  } finally {
    running.value = false
    abort = null
  }
}

/** 取消压缩 */
function onCancel(): void {
  abort?.abort()
}

/** 保存到手机的视频目录 */
async function onSave(): Promise<void> {
  const r = result.value
  if (!r || saving.value) return
  saving.value = true
  try {
    const saved = await saveCachedFile(r.path, r.name, VIDEO_OUT_MIME)
    showSuccessToast(`已保存到 ${saved.dir}`)
  } catch (e) {
    showFailToast(msgOf(e, '保存失败'))
  } finally {
    saving.value = false
  }
}

/** 分享压缩后的视频 */
async function onShare(): Promise<void> {
  const r = result.value
  if (!r || saving.value) return
  saving.value = true
  try {
    await share({ path: r.path, mime: VIDEO_OUT_MIME, title: r.name })
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
          <p class="vc-name">{{ video.name }}</p>
          <p class="tool-hint">
            {{ formatBytes(srcBytes) }}<template v-if="info?.durationMs"> · {{ formatDuration(info.durationMs) }}</template
            ><template v-if="info?.width && info?.height"> · {{ info.width }}×{{ info.height }}</template
            ><template v-if="info?.fps"> · {{ Math.round(info.fps) }} 帧/秒</template>
          </p>
          <p v-if="!audioCheck.ok" class="vc-bad">{{ audioCheck.text }}</p>
        </template>
        <ul class="vc-limits">
          <li v-for="t in LIMITS" :key="t">{{ t }}</li>
        </ul>
      </tool-group>

      <tool-group v-if="video && info">
        <div class="tool-group__title">2. 选择压缩档位</div>
        <div class="vc-presets">
          <button
            v-for="(p, i) in PRESETS"
            :key="p.key"
            type="button"
            class="vc-preset"
            :class="{ 'vc-preset--on': preset === p.key }"
            :disabled="running"
            @click="preset = p.key"
          >
            <span class="vc-preset__name">{{ p.name }}</span>
            <span class="vc-preset__size">{{ estimates[i] === null ? '未知' : `约 ${formatBytes(estimates[i] as number)}` }}</span>
          </button>
        </div>
        <p class="tool-hint">{{ PRESETS.find((p) => p.key === preset)?.hint }}。预计体积按码率估算，实际可能有出入。</p>
        <p v-if="warning" class="vc-warn">{{ warning }}</p>

        <div v-if="running" class="vc-running">
          <van-progress :percentage="percent" stroke-width="8" />
        </div>
      </tool-group>

      <tool-group v-if="result">
        <div class="tool-group__title">3. 压缩结果</div>
        <div class="vc-compare">
          <div class="vc-compare__col">
            <div class="vc-compare__label">压缩前</div>
            <div class="vc-compare__value">{{ formatBytes(result.srcBytes || srcBytes) }}</div>
          </div>
          <div class="vc-compare__col">
            <div class="vc-compare__label">压缩后</div>
            <div class="vc-compare__value">{{ formatBytes(result.bytes) }}</div>
          </div>
          <div class="vc-compare__col">
            <div class="vc-compare__label">变化</div>
            <div class="vc-compare__value" :class="notSmaller ? 'vc-bad' : 'vc-ok'">{{ changeText(result.srcBytes || srcBytes, result.bytes) }}</div>
          </div>
        </div>
        <p v-if="notSmaller" class="vc-warn">{{ result.message || NOT_SMALLER_TEXT }}</p>
      </tool-group>
    </template>

    <!-- 底部动作栏：相册选视频，保存 / 分享压缩结果，主按钮开始压缩（压缩中变成取消） -->
    <bottom-actions :main-loading="running" :actions="{ save: { disabled: !result || saving, text: '保存到手机' }, share: { disabled: !result || saving } }" v-if="hosted" album main :main-text="running ? '取消' : '开始压缩'" :main-type="running ? 'danger' : 'primary'" :disabled="{ album: running, main: !running && !canRun }" @album="onPick" @main="running ? onCancel() : onCompress()" @save="onSave" @share="onShare" />
  </div>
</template>

<style lang="scss" scoped>
/* 文件名，过长省略 */
.vc-name {
  margin: $space-3 0 $space-1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--c-text);
}

/* 限制说明列表 */
.vc-limits {
  margin: $space-3 0 0;
  padding-left: $space-4;
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-text-muted);
}

/* 红字 */
.vc-bad {
  color: var(--c-error);
}

/* 绿字 */
.vc-ok {
  color: var(--c-ok);
}

/* 警示文字 */
.vc-warn {
  margin: $space-2 0 0;
  font-size: 13px;
  color: var(--c-warn-text);
}

/* 三档预设并排 */
.vc-presets {
  display: flex;
  gap: $space-2;
}

/* 单个预设按钮 */
.vc-preset {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-1;
  padding: $space-3 $space-2;
  color: var(--c-text);
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: $radius;

  /* 选中 */
  &--on {
    color: var(--c-primary);
    border-color: var(--c-primary);
  }

  &:disabled {
    opacity: 0.6;
  }
}

/* 预设名 */
.vc-preset__name {
  font-size: 15px;
  font-weight: 500;
}

/* 预设预计体积 */
.vc-preset__size {
  font-size: 12px;
  color: var(--c-text-muted);
}

/* 进度行 */
.vc-running {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-top: $space-4;

  .van-progress {
    flex: 1;
  }
}

/* 前后对比三列 */
.vc-compare {
  display: flex;
  text-align: center;
}

/* 对比的一列 */
.vc-compare__col {
  flex: 1;
}

/* 对比标签 */
.vc-compare__label {
  font-size: 12px;
  color: var(--c-text-muted);
}

/* 对比数值 */
.vc-compare__value {
  margin-top: $space-1;
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
