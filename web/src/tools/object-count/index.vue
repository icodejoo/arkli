<script setup lang="ts">
// 对象计数：纯 JS 实现（灰度 → Otsu → 连通域 → 面积过滤），点击画面可手动加/删计数点
import BottomActions from '@/shared/BottomActions.vue'
import CellPicker from '@/shared/CellPicker.vue'
import ModelPicker from '@/shared/ModelPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { showToast } from 'vant'
import { fitMaxEdge } from '@/shared/image-calc'
import { createCanvas, drawScaled, loadBitmap, EDIT_BASIC, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'
import { shootPhoto } from '@/shared/shootPhoto'
import {
  binarize,
  defaultMinArea,
  detect,
  emptyEdits,
  guessMode,
  HIT_RADIUS_PX,
  MAX_EDGE,
  otsu,
  sortMarkers,
  toGray,
  toggleAt,
  visibleMarkers,
  type Edits,
  type Marker,
  type ObjectMode,
} from './logic'

/** 本工具 id（模型选择器用） */
const TOOL_ID = 'object-count'

/** 滑杆防抖毫秒数 */
const DEBOUNCE_MS = 120
/** 最小面积滑杆上限占画面的比例 */
const MIN_AREA_SLIDER_RATIO = 0.02
/** 标记颜色 */
const MARK_COLOR = '#e11d48'
/** 标记圆点半径（屏幕像素） */
const DOT_RADIUS_PX = 5
/** 编号字号（屏幕像素） */
const LABEL_FONT_PX = 12
/** 二值图预览：物体色与背景色 */
const MASK_OBJECT = 40
const MASK_BG = 235

/** 已选图片 */
const image = shallowRef<PickedImage | null>(null)
/** 正在解码 */
const loading = ref(false)
/** 显示用画布 */
const canvas = ref<HTMLCanvasElement | null>(null)
/** 缩放后的尺寸 */
const size = ref({ w: 0, h: 0 })
/** 缩放后原图像素（用于重绘底图） */
const base = shallowRef<ImageData | null>(null)
/** 灰度 */
const gray = shallowRef<Uint8Array | null>(null)
/** 阈值 */
const threshold = ref(128)
/** Otsu 自动阈值 */
const autoThreshold = ref(128)
/** 物体亮暗选项 */
const MODE_OPTIONS: readonly CellOption[] = [
  { value: 'dark', label: '暗物体（浅底）' },
  { value: 'bright', label: '亮物体（深底）' },
]
/** 物体亮暗 */
const mode = ref<ObjectMode>('dark')
/** 最小面积 */
const minArea = ref(4)
/** 是否显示二值图 */
const showMask = ref(false)
/** 自动检测结果 */
const auto = shallowRef<Marker[]>([])
/** 手动修正 */
const edits = shallowRef<Edits>(emptyEdits())
/** 防抖定时器 */
let timer: ReturnType<typeof setTimeout> | null = null

/** 最终标记（已排序，下标+1 即编号） */
const markers = computed(() => {
  const gap = Math.max(4, size.value.h * 0.03)
  return sortMarkers(visibleMarkers(auto.value, edits.value), gap)
})
/** 最小面积滑杆上限 */
const minAreaMax = computed(() => Math.max(20, Math.round(size.value.w * size.value.h * MIN_AREA_SLIDER_RATIO)))
/** 是否有手动修正 */
const edited = computed(() => edits.value.added.length + edits.value.removed.length > 0)

/** 清掉所有位图状态 */
function reset(): void {
  base.value = null
  gray.value = null
  auto.value = []
  edits.value = emptyEdits()
  size.value = { w: 0, h: 0 }
}

/** 采用新图：缩小到最长边 ≤ MAX_EDGE，再算灰度与 Otsu */
async function adopt(img: PickedImage): Promise<void> {
  try {
    loading.value = true
    image.value?.release()
    image.value = img
    reset()
    const bmp = await loadBitmap(img)
    const fit = fitMaxEdge(bmp.width, bmp.height, MAX_EDGE)
    const scaled = drawScaled(bmp, fit.width, fit.height, '#ffffff')
    bmp.close()
    const data = scaled.getContext('2d')!.getImageData(0, 0, scaled.width, scaled.height)
    releaseCanvas(scaled)
    const g = toGray(data.data, data.width, data.height)
    const t = otsu(g)
    base.value = data
    gray.value = g
    size.value = { w: data.width, h: data.height }
    autoThreshold.value = t
    threshold.value = t
    mode.value = guessMode(g, data.width, data.height, t)
    minArea.value = defaultMinArea(data.width, data.height)
    recompute()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
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
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照 */
async function shoot(): Promise<void> {
  const got = await shootPhoto()
  if (got) await adopt(got)
}

/** 按当前参数重新检测，并清掉手动修正 */
function recompute(): void {
  const g = gray.value
  if (!g) return
  auto.value = detect(g, size.value.w, size.value.h, { threshold: threshold.value, mode: mode.value, minArea: minArea.value })
  edits.value = emptyEdits()
}

/** 重绘画布：底图（或二值图）+ 编号标记 */
function draw(): void {
  const c = canvas.value
  const data = base.value
  if (!c || !data) return
  c.width = data.width
  c.height = data.height
  const ctx = c.getContext('2d')!
  if (showMask.value && gray.value) {
    const m = binarize(gray.value, threshold.value, mode.value)
    const out = ctx.createImageData(data.width, data.height)
    for (let i = 0; i < m.length; i++) {
      const v = m[i] ? MASK_OBJECT : MASK_BG
      out.data[i * 4] = v
      out.data[i * 4 + 1] = v
      out.data[i * 4 + 2] = v
      out.data[i * 4 + 3] = 255
    }
    ctx.putImageData(out, 0, 0)
  } else {
    ctx.putImageData(data, 0, 0)
  }
  // 标记大小按显示比例换算，让屏幕上看到的大小稳定
  const k = c.clientWidth ? c.width / c.clientWidth : 1
  ctx.font = `bold ${LABEL_FONT_PX * k}px sans-serif`
  ctx.textBaseline = 'bottom'
  ctx.lineWidth = 3 * k
  markers.value.forEach((p, i) => {
    ctx.fillStyle = MARK_COLOR
    ctx.beginPath()
    ctx.arc(p.x, p.y, DOT_RADIUS_PX * k, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.strokeText(String(i + 1), p.x + 4 * k, p.y - 4 * k)
    ctx.fillText(String(i + 1), p.x + 4 * k, p.y - 4 * k)
  })
}

/** 点击画面：命中标记则删除，否则添加 */
function onTap(ev: MouseEvent): void {
  const c = canvas.value
  if (!c || !base.value) return
  const rect = c.getBoundingClientRect()
  if (!rect.width) return
  const k = c.width / rect.width
  edits.value = toggleAt(auto.value, edits.value, (ev.clientX - rect.left) * k, (ev.clientY - rect.top) * k, HIT_RADIUS_PX * k)
}

/** 清掉手动修正 */
function clearEdits(): void {
  edits.value = emptyEdits()
}

/** 阈值回到 Otsu 自动值 */
function useAuto(): void {
  threshold.value = autoThreshold.value
}

// 参数变化：防抖后重算
watch([threshold, mode, minArea], () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(recompute, DEBOUNCE_MS)
})
// 数据或显示开关变化：重绘（等画布挂载后）
watch([markers, showMask, threshold, base], () => nextTick(draw), { flush: 'post' })

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  image.value?.release()
})
</script>

<template>
  <div class="tool-page">
    <tool-group title="选择图片">
      <canvas v-show="base" ref="canvas" class="stage" @click="onTap" />
      <p v-if="!image" class="tool-hint">点底部「相册」或「拍照」选一张图。</p>
      <p class="tool-hint">相互粘连的物体会被算成一个，可以点画面手动补点；点已有的标记则删除它。</p>
    </tool-group>

    <tool-group v-if="base" :title="`共 ${markers.length} 个`">
      <van-cell-group :border="false">
        <cell-picker v-model="mode" title="物体颜色" :options="MODE_OPTIONS" />
        <van-cell title="阈值" :value="String(threshold)" />
      </van-cell-group>
      <div class="is-slider"><van-slider v-model="threshold" :min="0" :max="255" /></div>
      <van-cell-group :border="false">
        <van-cell title="最小面积（滤噪点）" :value="`${minArea} px`" />
      </van-cell-group>
      <div class="is-slider"><van-slider v-model="minArea" :min="1" :max="minAreaMax" /></div>
      <van-cell-group :border="false">
        <van-cell title="显示二值图" center>
          <template #right-icon><van-switch v-model="showMask" size="22" /></template>
        </van-cell>
      </van-cell-group>
      <div class="actions">
        <van-button size="small" plain round @click="useAuto">阈值恢复自动</van-button>
        <van-button size="small" plain round :disabled="!edited" @click="clearEdits">清除手动修正</van-button>
      </div>
      <p class="tool-hint">调整颜色、阈值、面积后会重新检测，手动修正会被清掉；建议先调参数，最后再手动补点。</p>
    </tool-group>

    <!-- 底部动作栏：选图后自动检测，没有单独的开始按钮；右边主按钮是拍照 -->
    <bottom-actions :main-loading="loading" ai album main main-text="拍照" main-type="danger" :disabled="{ album: loading, main: loading }" @album="choose" @main="shoot">
      <template #ai><model-picker :tool-id="TOOL_ID" variant="bar" /></template>
    </bottom-actions>
  </div>
</template>

<style lang="scss" scoped>
/* 画布按宽度自适应，点按可加点 */
.stage {
  display: block;
  width: 100%;
  height: auto;
  margin-bottom: $space-3;
  border-radius: 8px;
  cursor: crosshair;
}

.is-slider {
  padding: $space-2 $space-3 $space-3;
}

.actions {
  display: flex;
  gap: $space-2;
  margin: $space-2 0;
}
</style>
