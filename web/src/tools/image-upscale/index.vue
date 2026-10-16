<script setup lang="ts">
// 图像分辨率提升：选图 → 2×/4× → 本地超分 → 前后对比滑块 → 保存
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { outputName } from '@/shared/image-calc'
import { shootPhoto } from '@/shared/shootPhoto'
import { EDIT_BASIC, pickImages, saveBlob, type PickedImage } from '@/shared/image-io'
import { aiUpscale, AiNotReadyError, fetchAiResult } from '@/native/ai'
import AiGapNotice from '@/tools/_ai/AiGapNotice.vue'
import { useAiModel } from '@/tools/_ai/useAiModel'
import { aiErrorText, resolveImagePath } from '@/tools/_ai/aiImage'
import { DEFAULT_SPLIT, estimateText, estimateUpscale, maxAllowedScale, scaleSuffix, splitClip, splitFromPointer, type UpscaleScale } from './logic'

/** 模型状态 */
const { ready, checked, loading: checking, refresh, markNotReady } = useAiModel('upscale')

/** 已选图片 */
const image = shallowRef<PickedImage | null>(null)
/** 放大倍数 */
const scale = ref<UpscaleScale>(2)
/** 处理中 */
const busy = ref(false)
/** 保存中 */
const saving = ref(false)
/** 结果图 */
const result = shallowRef<{ blob: Blob; url: string; width: number; height: number; scale: UpscaleScale } | null>(null)
/** 对比滑块位置 0~1 */
const split = ref(DEFAULT_SPLIT)
/** 对比容器 */
const compare = ref<HTMLElement | null>(null)

/** 当前倍数下的预估 */
const estimate = computed(() => (image.value ? estimateUpscale(image.value.width, image.value.height, scale.value) : null))
/** 当前图允许的最大倍数 */
const allowed = computed(() => (image.value ? maxAllowedScale(image.value.width, image.value.height) : 4))
/** 「处理前」图层裁剪样式 */
const beforeClip = computed(() => splitClip(split.value))
/** 分隔线位置 */
const handleLeft = computed(() => `${split.value * 100}%`)

/** 清掉旧结果 */
function clearResult(): void {
  if (result.value) URL.revokeObjectURL(result.value.url)
  result.value = null
  split.value = DEFAULT_SPLIT
}

/** 采用新图：释放旧图、清掉旧结果，倍数超限时回落到 2× */
function adopt(img: PickedImage): void {
  image.value?.release()
  image.value = img
  clearResult()
  if (scale.value > maxAllowedScale(img.width, img.height)) scale.value = 2
}

/** 相册选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ edit: EDIT_BASIC, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got.length) adopt(got[0])
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照 */
async function shoot(): Promise<void> {
  const got = await shootPhoto()
  if (got) adopt(got)
}

/** 开始放大 */
async function run(): Promise<void> {
  if (!image.value || busy.value) return
  busy.value = true
  try {
    const path = await resolveImagePath(image.value)
    const res = await aiUpscale(path, scale.value)
    const blob = await fetchAiResult(res.path)
    clearResult()
    result.value = { blob, url: URL.createObjectURL(blob), width: res.width, height: res.height, scale: scale.value }
  } catch (e) {
    if (e instanceof AiNotReadyError) markNotReady()
    else showFailToast(aiErrorText(e))
  } finally {
    busy.value = false
  }
}

/** 拖动分隔线 */
function onPointer(ev: PointerEvent): void {
  const el = compare.value
  if (!el) return
  if (ev.type === 'pointerdown') el.setPointerCapture(ev.pointerId)
  else if (!el.hasPointerCapture(ev.pointerId)) return
  const rect = el.getBoundingClientRect()
  split.value = splitFromPointer(ev.clientX, rect.left, rect.width)
}

/** 保存结果 */
async function save(): Promise<void> {
  const r = result.value
  if (!r || !image.value || saving.value) return
  saving.value = true
  try {
    const res = await saveBlob(r.blob, outputName(image.value.name, r.blob.type || 'image/png', scaleSuffix(r.scale)))
    showSuccessToast(res.mode === 'native' ? '已保存到相册' : '已下载')
  } catch (e) {
    showFailToast(aiErrorText(e))
  } finally {
    saving.value = false
  }
}

onBeforeUnmount(() => {
  clearResult()
  image.value?.release()
})
</script>

<template>
  <div class="tool-page">
    <tool-group title="选择图片">
      <img v-if="image && !result" class="preview" :src="image.url" alt="原图" />
      <div
        v-if="result && image"
        ref="compare"
        class="compare"
        @pointerdown="onPointer"
        @pointermove="onPointer"
      >
        <img class="compare__img" :src="result.url" alt="放大后" draggable="false" />
        <img class="compare__img compare__img--top" :style="{ clipPath: beforeClip }" :src="image.url" alt="原图" draggable="false" />
        <span class="compare__tag compare__tag--l">原图</span>
        <span class="compare__tag compare__tag--r">放大后</span>
        <div class="compare__bar" :style="{ left: handleLeft }"><span class="compare__knob">⇆</span></div>
      </div>
      <p v-if="image" class="tool-hint">原图 {{ image.width }}×{{ image.height }}</p>
      <p v-else class="tool-hint">点底部「相册」或「拍照」选一张图。</p>
      <van-cell title="放大倍数" center>
        <template #value>
          <van-radio-group v-model="scale" direction="horizontal" class="is-radios">
            <van-radio :name="2" :disabled="allowed < 2">2×</van-radio>
            <van-radio :name="4" :disabled="allowed < 4">4×</van-radio>
          </van-radio-group>
        </template>
      </van-cell>
      <p v-if="estimate" class="tool-hint" :class="{ 'is-warn': estimate.tooBig }">{{ estimateText(estimate) }}</p>
    </tool-group>

    <ai-gap-notice v-if="checked && !ready" feature="图像超分" purpose="把小图放大并补回细节" size="约 4.7MB" retry :loading="checking" @retry="refresh" />

    <tool-group v-if="result" :title="`结果 ${result.width}×${result.height}`">
      <p class="tool-hint">左右拖动对比前后效果。</p>
    </tool-group>

    <!-- 底部动作栏：相册 / 拍照选图，保存结果，主按钮开始放大 -->
    <bottom-actions :actions="{ save: { disabled: !result || saving } }" album photo main :main-text="busy ? '放大中' : '开始放大'" :disabled="{ album: busy, photo: busy, main: busy || !image || !ready || !!estimate?.tooBig }" @album="choose" @photo="shoot" @main="run" @save="save" />
  </div>
</template>

<style lang="scss" scoped>
.is-radios {
  justify-content: flex-end;
}

.preview {
  display: block;
  width: 100%;
  height: auto;
  margin-bottom: $space-3;
  border-radius: 8px;
}

/* 对比容器：两张图叠放，上面那张按滑块裁剪；纵向滚动仍可用 */
.compare {
  position: relative;
  margin-bottom: $space-3;
  line-height: 0;
  touch-action: pan-y;
  user-select: none;

  &__img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 8px;

    &--top {
      position: absolute;
      inset: 0;
      height: 100%;
      object-fit: fill;
    }
  }

  &__tag {
    position: absolute;
    top: 8px;
    padding: 2px 8px;
    font-size: 12px;
    line-height: 18px;
    color: #fff;
    background: rgba(0, 0, 0, 0.5);
    border-radius: 10px;

    &--l {
      left: 8px;
    }

    &--r {
      right: 8px;
    }
  }

  &__bar {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: #fff;
    box-shadow: 0 0 4px rgba(0, 0, 0, 0.5);
  }

  &__knob {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 32px;
    height: 32px;
    margin: -16px 0 0 -16px;
    font-size: 16px;
    line-height: 32px;
    color: var(--c-text);
    text-align: center;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }
}

.is-warn {
  color: var(--c-error);
}
</style>
