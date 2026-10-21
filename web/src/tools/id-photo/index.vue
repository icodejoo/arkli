<script setup lang="ts">
// 证件照：选图 → 选规格 → 拖动/缩放裁剪框 → 换底色（AI 抠图 或 纯色背景抠图兜底）→ 导出
import BottomActions from '@/shared/BottomActions.vue'
import ColorPicker from '@/shared/ColorPicker.vue'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { showFailToast, showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { shootPhoto } from '@/shared/shootPhoto'
import { FORMAT_MIME, fitMaxEdge, outputName } from '@/shared/image-calc'
import { canvasToBlob, createCanvas, drawScaled, loadBitmap, EDIT_BASIC, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'
import { aiMatte, AiNotReadyError, fetchAiResult } from '@/native/ai'
import AiGapNotice from '@/tools/_ai/AiGapNotice.vue'
import { useAiModel } from '@/tools/_ai/useAiModel'
import { aiErrorText, resolveImagePath } from '@/tools/_ai/aiImage'
import {
  BG_PRESETS,
  CUSTOM_ID,
  CUSTOM_MAX,
  CUSTOM_MIN,
  FRAC_MAX,
  FRAC_MIN,
  ID_SPECS,
  clampCrop,
  cropRect,
  customSpec,
  hexToRgb,
  initialCrop,
  moveCrop,
  pinchFrac,
  rectToPercent,
  replaceBackground,
  rgbToHex,
  sampleColor,
  specAspect,
  MAX_COLOR_DISTANCE,
  type CropState,
  type IdSpec,
  type Rgb,
} from './logic'

/** 取色用的缩小图最长边 */
const SAMPLE_EDGE = 800
/** 默认容差 */
const TOLERANCE_DEFAULT = 50
/** 容差滑杆上限 */
const TOLERANCE_MAX = 160
/** JPEG 质量 */
const JPEG_QUALITY = 0.95
/** 输出文件名后缀前缀 */
const NAME_SUFFIX = '_idphoto'
/** 抠图方式 */
type MattingMode = 'none' | 'ai' | 'chroma'

/** 抠图模型状态 */
const { ready, checked, loading: checking, refresh, markNotReady } = useAiModel('matte')
/** 结果与处理状态 */
const { results, busy, saving, process, saveAll, clear } = useImageResults()

/** 已选图片 */
const image = shallowRef<PickedImage | null>(null)
/** 解码后的原图位图（用于导出） */
const bitmap = shallowRef<ImageBitmap | null>(null)
/** AI 抠图结果位图（带 alpha），换图时清掉 */
const matted = shallowRef<ImageBitmap | null>(null)
/** 取色用的缩小图像素 */
const sample = shallowRef<ImageData | null>(null)
/** 选图/解码中 */
const loading = ref(false)
/** 规格标识 */
const specId = ref(ID_SPECS[0].id)
/** 规格选项：预设规格 + 自定义 */
const SPEC_OPTIONS = [...ID_SPECS.map((s) => ({ value: s.id, label: s.name })), { value: CUSTOM_ID, label: '自定义' }]
/** 输出格式选项 */
const FORMAT_OPTIONS = [
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG' },
]
/** 自定义宽 */
const customW = ref(413)
/** 自定义高 */
const customH = ref(531)
/** 裁剪状态 */
const crop = ref<CropState>({ frac: FRAC_MAX, cx: 0, cy: 0 })
/** 抠图方式 */
const matting = ref<MattingMode>('none')
/** 抠图方式选项；AI 抠图在模型未就绪时禁用 */
const MATTING_OPTIONS = computed<CellOption[]>(() => [
  { value: 'none', label: '保持原背景' },
  { value: 'chroma', label: '纯色背景抠图' },
  { value: 'ai', label: 'AI 抠图', disabled: !ready.value },
])
/** 底色预设标识，`custom` 为自定义 */
const bgId = ref(BG_PRESETS[1].id)
/** 自定义底色 */
const bgCustom = ref('#ffffff')
/** 纯色抠图的原背景取色 */
const key = ref<Rgb | null>(null)
/** 正在等用户点图取色 */
const picking = ref(false)
/** 容差 */
const tolerance = ref(TOLERANCE_DEFAULT)
/** 是否只抠与边缘相连的背景 */
const onlyConnected = ref(true)
/** 输出格式 */
const format = ref<'png' | 'jpeg'>('jpeg')
/** 预览容器 */
const stage = ref<HTMLElement | null>(null)

/** 当前规格 */
const spec = computed<IdSpec>(() => (specId.value === CUSTOM_ID ? customSpec(customW.value, customH.value) : ID_SPECS.find((s) => s.id === specId.value)!))
/** 框宽高比 */
const aspect = computed(() => specAspect(spec.value))
/** 原图宽 */
const iw = computed(() => image.value?.width ?? 0)
/** 原图高 */
const ih = computed(() => image.value?.height ?? 0)
/** 框在预览上的百分比定位 */
const frameStyle = computed(() => {
  if (!iw.value) return {}
  const p = rectToPercent(cropRect(iw.value, ih.value, aspect.value, crop.value), iw.value, ih.value)
  return { left: `${p.left}%`, top: `${p.top}%`, width: `${p.width}%`, height: `${p.height}%` }
})
/** 框大小滑杆（百分比） */
const fracPercent = computed({
  get: () => Math.round(crop.value.frac * 100),
  set: (v: number) => {
    crop.value = clampCrop(iw.value, ih.value, aspect.value, { ...crop.value, frac: v / 100 })
  },
})
/** 当前底色 */
const bgColor = computed(() => (bgId.value === 'custom' ? bgCustom.value : BG_PRESETS.find((b) => b.id === bgId.value)!.color))
/** 取色的十六进制，供色块显示 */
const keyHex = computed(() => (key.value ? rgbToHex(key.value) : ''))
/** 能否生成 */
const canRun = computed(() => !!bitmap.value && (matting.value !== 'chroma' || !!key.value) && (matting.value !== 'ai' || ready.value))

/** 换图或换规格时重置裁剪框 */
function resetCrop(): void {
  if (iw.value) crop.value = initialCrop(iw.value, ih.value, aspect.value)
}
watch([aspect], resetCrop)

/** 释放位图资源 */
function freeBitmaps(): void {
  bitmap.value?.close()
  matted.value?.close()
  bitmap.value = null
  matted.value = null
  sample.value = null
}

/** 采用新图并解码，同时生成取色用的缩小图 */
async function adopt(img: PickedImage): Promise<void> {
  try {
    loading.value = true
    clear()
    freeBitmaps()
    image.value?.release()
    image.value = img
    key.value = null
    picking.value = false
    const bmp = await loadBitmap(img)
    bitmap.value = bmp
    const fit = fitMaxEdge(bmp.width, bmp.height, SAMPLE_EDGE)
    const small = drawScaled(bmp, fit.width, fit.height)
    sample.value = small.getContext('2d')!.getImageData(0, 0, small.width, small.height)
    releaseCanvas(small)
    resetCrop()
  } catch (e) {
    showFailToast(aiErrorText(e))
  } finally {
    loading.value = false
  }
}

/** 相册选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ edit: EDIT_BASIC, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got.length) await adopt(got[0])
  } catch (e) {
    showFailToast(aiErrorText(e))
  }
}

/** 拍照 */
async function shoot(): Promise<void> {
  const got = await shootPhoto()
  if (got) await adopt(got)
}

/** 活动指针，用于平移/双指缩放 */
const pointers = new Map<number, { x: number; y: number }>()
/** 双指手势起点 */
let pinchStart: { dist: number; frac: number } | null = null

/** 两指距离 */
function pointerDistance(): number {
  const [a, b] = Array.from(pointers.values())
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 指针按下：取色模式下采样，否则开始拖动 */
function onDown(ev: PointerEvent): void {
  const el = stage.value
  if (!el || !image.value) return
  if (picking.value) {
    pickKey(ev)
    return
  }
  el.setPointerCapture(ev.pointerId)
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
  pinchStart = pointers.size === 2 ? { dist: pointerDistance(), frac: crop.value.frac } : null
}

/** 指针移动：单指平移框，双指缩放框 */
function onMove(ev: PointerEvent): void {
  const el = stage.value
  const prev = pointers.get(ev.pointerId)
  if (!el || !prev || !iw.value) return
  const cur = { x: ev.clientX, y: ev.clientY }
  pointers.set(ev.pointerId, cur)
  if (pointers.size === 1) {
    const k = iw.value / (el.clientWidth || 1)
    crop.value = moveCrop(iw.value, ih.value, aspect.value, crop.value, (cur.x - prev.x) * k, (cur.y - prev.y) * k)
  } else if (pointers.size === 2 && pinchStart) {
    crop.value = clampCrop(iw.value, ih.value, aspect.value, { ...crop.value, frac: pinchFrac(pinchStart.frac, pinchStart.dist, pointerDistance()) })
  }
}

/** 指针抬起/取消 */
function onUp(ev: PointerEvent): void {
  pointers.delete(ev.pointerId)
  pinchStart = pointers.size === 2 ? { dist: pointerDistance(), frac: crop.value.frac } : null
}

/** 取色：把点击位置换算到缩小图上采样 */
function pickKey(ev: PointerEvent): void {
  const el = stage.value
  const s = sample.value
  if (!el || !s) return
  const rect = el.getBoundingClientRect()
  const x = ((ev.clientX - rect.left) / rect.width) * s.width
  const y = ((ev.clientY - rect.top) / rect.height) * s.height
  key.value = sampleColor(s.data, s.width, s.height, x, y)
  picking.value = false
}

/** 取得抠好的位图：首次调用原生抠图并缓存 */
async function ensureMatted(img: PickedImage): Promise<ImageBitmap> {
  if (matted.value) return matted.value
  const res = await aiMatte(await resolveImagePath(img))
  const bmp = await createImageBitmap(await fetchAiResult(res.path))
  matted.value = bmp
  return bmp
}

/** 生成证件照 */
async function run(): Promise<void> {
  const img = image.value
  const orig = bitmap.value
  if (!img || !orig || busy.value) return
  const s = spec.value
  const mime = FORMAT_MIME[format.value]
  const bg = hexToRgb(bgColor.value) ?? [255, 255, 255]
  // process 会吞掉 worker 的错误，所以「未就绪」要在 worker 里就处理掉
  await process([0], async () => {
    let src = orig
    if (matting.value === 'ai') {
      try {
        src = await ensureMatted(img)
      } catch (e) {
        if (e instanceof AiNotReadyError) {
          markNotReady()
          matting.value = 'none'
          showToast(e.message)
        }
        throw e
      }
    }
    const ratio = src.width / orig.width
    const r = cropRect(orig.width, orig.height, aspect.value, crop.value)
    const sx = Math.round(r.x * ratio)
    const sy = Math.round(r.y * ratio)
    const sw = Math.max(1, Math.round(r.w * ratio))
    const sh = Math.max(1, Math.round(r.h * ratio))
    const piece = createCanvas(sw, sh)
    piece.getContext('2d')!.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh)
    const fillColor = matting.value === 'none' ? undefined : bgColor.value
    const out = drawScaled(piece, s.width, s.height, fillColor)
    releaseCanvas(piece)
    try {
      if (matting.value === 'chroma' && key.value) {
        const ctx = out.getContext('2d')!
        const data = ctx.getImageData(0, 0, out.width, out.height)
        const removed = replaceBackground(data.data, out.width, out.height, key.value, tolerance.value, bg, onlyConnected.value)
        if (!removed) showToast('没有抠到背景，试试重新取色或调大容差')
        ctx.putImageData(data, 0, 0)
      }
      const blob = await canvasToBlob(out, mime, format.value === 'jpeg' ? JPEG_QUALITY : undefined)
      return {
        name: outputName(img.name, mime, `${NAME_SUFFIX}_${s.width}x${s.height}`),
        blob,
        width: s.width,
        height: s.height,
        note: `${s.name}，300dpi 规格`,
      }
    } finally {
      releaseCanvas(out)
    }
  })
}

// 模型未就绪时，不允许停在 AI 抠图
watch(ready, (v) => {
  if (!v && matting.value === 'ai') matting.value = 'none'
})

onBeforeUnmount(() => {
  freeBitmaps()
  image.value?.release()
})
</script>

<template>
  <div class="tool-page">
    <tool-group title="选择照片">
      <div
        v-if="image"
        ref="stage"
        class="stage"
        :class="{ 'is-picking': picking }"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      >
        <img class="stage__img" :src="image.url" alt="待处理照片" draggable="false" />
        <div class="stage__frame" :style="frameStyle" />
      </div>
      <p v-if="image" class="tool-hint">{{ picking ? '请点一下照片上的背景处取色' : '拖动裁剪框定位，双指捏合或拖下面的滑杆调大小' }}</p>
      <p v-else class="tool-hint">点底部「相册」或「拍照」选一张人像照片。</p>
    </tool-group>

    <tool-group title="规格（300dpi，单位像素）">
      <cell-picker v-model="specId" title="规格" :options="SPEC_OPTIONS" />
      <div v-if="specId === CUSTOM_ID" class="custom">
        <van-field v-model.number="customW" type="digit" label="宽" :placeholder="`${CUSTOM_MIN}~${CUSTOM_MAX}`" />
        <van-field v-model.number="customH" type="digit" label="高" :placeholder="`${CUSTOM_MIN}~${CUSTOM_MAX}`" />
      </div>
      <van-cell title="裁剪框大小" :value="`${fracPercent}%`" />
      <div class="is-slider"><van-slider v-model="fracPercent" :min="FRAC_MIN * 100" :max="FRAC_MAX * 100" :disabled="!image" /></div>
    </tool-group>

    <tool-group title="背景">
      <cell-picker :model-value="matting" title="抠图方式" :options="MATTING_OPTIONS" @update:model-value="matting = $event as MattingMode" />

      <template v-if="matting === 'chroma'">
        <p class="tool-hint">仅适用于纯色背景的照片（白墙、蓝布等）。点「取背景色」后点照片上的背景处，再调容差。</p>
        <div class="key-row">
          <van-button size="small" plain round :type="picking ? 'primary' : 'default'" :disabled="!image" @click="picking = !picking">
            {{ picking ? '点照片取色中…' : '取背景色' }}
          </van-button>
          <span v-if="key" class="swatch" :style="{ background: keyHex }" />
          <span v-if="key" class="tool-hint">{{ keyHex }}</span>
        </div>
        <van-cell title="容差" :value="String(tolerance)" />
        <div class="is-slider"><van-slider v-model="tolerance" :min="1" :max="Math.min(TOLERANCE_MAX, MAX_COLOR_DISTANCE)" /></div>
        <van-cell title="只抠与边缘相连的背景" center label="避免人物身上同色的衣服被抠掉">
          <template #right-icon><van-switch v-model="onlyConnected" size="22" /></template>
        </van-cell>
      </template>

      <template v-if="matting !== 'none'">
        <p class="tool-hint">新底色</p>
        <div class="bg-row">
          <button
            v-for="b in BG_PRESETS"
            :key="b.id"
            type="button"
            class="bg-chip"
            :class="{ 'is-on': bgId === b.id }"
            :style="{ background: b.color }"
            :aria-label="`底色${b.name}`"
            @click="bgId = b.id"
          />
          <button type="button" class="bg-chip bg-chip--custom" :class="{ 'is-on': bgId === 'custom' }" :style="{ background: bgCustom }" aria-label="自定义底色" @click="bgId = 'custom'" />
          <color-picker v-if="bgId === 'custom'" v-model="bgCustom" label="自定义底色" />
        </div>
      </template>

      <cell-picker :model-value="format" title="输出格式" :options="FORMAT_OPTIONS" @update:model-value="format = $event as 'png' | 'jpeg'" />
    </tool-group>

    <ai-gap-notice v-if="checked && !ready" feature="AI 抠图" purpose="自动分离人像与背景，适合复杂背景" size="约 25MB" retry :loading="checking" @retry="refresh" />

    <tool-group v-if="results.length" title="结果（点击预览）">
      <image-result-list :results="results" />
    </tool-group>

    <!-- 底部动作栏：相册 / 拍照选图，保存结果，主按钮生成证件照 -->
    <bottom-actions :main-loading="busy" :actions="{ save: { disabled: !results.length || saving } }" album photo main :main-text="busy ? '生成中' : '生成证件照'" :disabled="{ album: busy || loading, photo: busy || loading, main: busy || !canRun }" @album="choose" @photo="shoot" @main="run" @save="saveAll" />
  </div>
</template>

<style lang="scss" scoped>
/* 预览：图自适应宽度，框叠在上面；touch-action 关掉浏览器手势，交给 Pointer Events */
.stage {
  position: relative;
  margin-bottom: $space-3;
  overflow: hidden;
  line-height: 0;
  touch-action: none;
  user-select: none;
  border-radius: 8px;

  &.is-picking {
    cursor: crosshair;
  }

  &__img {
    display: block;
    width: 100%;
    height: auto;
  }

  /* 裁剪框：外面用超大阴影压暗 */
  &__frame {
    position: absolute;
    border: 2px solid #fff;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
    pointer-events: none;
  }
}

.is-slider {
  padding: $space-2 $space-3 $space-3;
}

.key-row {
  display: flex;
  gap: $space-2;
  align-items: center;
  margin: $space-2 0;
}

.swatch {
  width: 24px;
  height: 24px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
}

.bg-row {
  display: flex;
  gap: $space-3;
  align-items: center;
  margin: $space-2 0 $space-3;
}

/* 底色色块 */
.bg-chip {
  width: 36px;
  height: 36px;
  padding: 0;
  border: 2px solid var(--c-border);
  border-radius: 50%;

  &.is-on {
    border-color: var(--c-primary);
    box-shadow: 0 0 0 2px var(--c-surface), 0 0 0 4px var(--c-primary);
  }
}

</style>
