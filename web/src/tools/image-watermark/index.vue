<script setup lang="ts">
// 图片水印：文字水印，九宫格单个或整图平铺，可调字号/颜色/透明度/旋转，支持多图批量
import BottomActions from '@/shared/BottomActions.vue'
import ColorPicker from '@/shared/ColorPicker.vue'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { shootPhoto } from '@/shared/shootPhoto'
import { FORMAT_MIME, fitMaxEdge, outputName } from '@/shared/image-calc'
import { canvasToBlob, createCanvas, drawScaled, loadBitmap, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'
import { clamp, fontPx, layoutWatermark, type WatermarkMode } from './logic'

/** 最多处理张数 */
const MAX_PICK = 20
/** 输出 JPEG 质量 */
const JPEG_QUALITY = 0.92
/** 预览图最长边 */
const PREVIEW_EDGE = 480
/** 输出文件名后缀 */
const NAME_SUFFIX = '-wm'
/** 水印字体（只用系统字体） */
const FONT_FAMILY = 'sans-serif'
/** 九宫格位置文案（行优先） */
const POSITION_LABELS = ['左上', '上中', '右上', '左中', '居中', '右中', '左下', '下中', '右下']
/** 字号占短边百分比范围 */
const FONT_RANGE = { min: 2, max: 20 }
/** 透明度百分比范围 */
const OPACITY_RANGE = { min: 5, max: 100 }
/** 旋转角度范围 */
const ROTATION_RANGE = { min: -90, max: 90 }
/** 平铺间距百分比范围（占字号） */
const GAP_RANGE = { min: 0, max: 300 }

/** 已选图片 */
const images = ref<PickedImage[]>([])
/** 水印文字 */
const text = ref('仅供办理业务使用')
/** 模式 */
const mode = ref<WatermarkMode>('tile')
/** 九宫格位置 */
const position = ref(8)
/** 字号占短边的百分比 */
const sizePct = ref(5)
/** 颜色 */
const color = ref('#ffffff')
/** 透明度（百分比） */
const opacity = ref(45)
/** 旋转角度 */
const rotation = ref(-30)
/** 平铺横向间距（占字号百分比） */
const gapX = ref(80)
/** 平铺纵向间距（占字号百分比） */
const gapY = ref(120)
/** 平铺时奇数行是否错开 */
const stagger = ref(true)
/** 输出格式 */
const format = ref<'png' | 'jpeg'>('jpeg')

/** 预览画布元素 */
const previewEl = ref<HTMLCanvasElement | null>(null)
/** 预览底图（缩小后的第一张图，用完在卸载/换图时释放） */
let previewBase: HTMLCanvasElement | null = null
/** 结果与批处理状态 */
const { results, busy, progress, saving, process, saveAll, clear } = useImageResults()

/**
 * 在画布上画水印。字号按短边百分比换算，所以预览和原尺寸输出效果一致。
 *
 * @param ctx 2D 上下文
 * @param w 画布宽
 * @param h 画布高
 */
function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const content = text.value.trim()
  if (!content) return
  const fs = fontPx(w, h, sizePct.value)
  ctx.save()
  ctx.font = `bold ${fs}px ${FONT_FAMILY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = color.value
  ctx.globalAlpha = clamp(opacity.value / 100, 0, 1)
  const centers = layoutWatermark(w, h, ctx.measureText(content).width, fs, {
    mode: mode.value,
    position: position.value,
    rotation: rotation.value,
    gapX: gapX.value,
    gapY: gapY.value,
    stagger: stagger.value,
  })
  const rad = (rotation.value * Math.PI) / 180
  for (const p of centers) {
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(rad)
    ctx.fillText(content, 0, 0)
    ctx.restore()
  }
  ctx.restore()
}

/** 重画预览：底图 + 当前水印 */
function redraw(): void {
  const el = previewEl.value
  if (!el || !previewBase) return
  el.width = previewBase.width
  el.height = previewBase.height
  const ctx = el.getContext('2d')!
  ctx.drawImage(previewBase, 0, 0)
  drawWatermark(ctx, el.width, el.height)
}

/** 用第一张图生成预览底图 */
async function buildPreview(): Promise<void> {
  if (previewBase) releaseCanvas(previewBase)
  previewBase = null
  const first = images.value[0]
  if (!first) return
  try {
    const bmp = await loadBitmap(first)
    const size = fitMaxEdge(bmp.width, bmp.height, PREVIEW_EDGE)
    previewBase = drawScaled(bmp, size.width, size.height)
    bmp.close()
    await nextTick()
    redraw()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '预览生成失败')
  }
}

/** 追加图片：清掉旧结果，首张到位时生成预览底图 */
async function append(got: PickedImage[]): Promise<void> {
  if (!got.length) return
  const hadFirst = images.value.length > 0
  images.value = images.value.concat(got)
  clear()
  if (!hadFirst) await buildPreview()
}

/** 相册选图（追加） */
async function add(): Promise<void> {
  const room = MAX_PICK - images.value.length
  if (room <= 0) {
    showToast(`最多 ${MAX_PICK} 张`)
    return
  }
  try {
    await append(await pickImages({ multiple: true, max: room, onFailed: (f) => showToast(`${f.length} 张读取失败：${f[0].message}`) }))
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照（追加一张） */
async function shoot(): Promise<void> {
  if (images.value.length >= MAX_PICK) {
    showToast(`最多 ${MAX_PICK} 张`)
    return
  }
  const got = await shootPhoto()
  if (got) await append([got])
}

/** 清空已选 */
function reset(): void {
  images.value.forEach((i) => i.release())
  images.value = []
  clear()
  if (previewBase) releaseCanvas(previewBase)
  previewBase = null
}

/** 逐张加水印并导出，一张处理完立刻释放画布 */
async function run(): Promise<void> {
  const mime = FORMAT_MIME[format.value]
  await process(images.value.slice(), async (img) => {
    const bmp = await loadBitmap(img)
    const canvas = createCanvas(bmp.width, bmp.height)
    try {
      const ctx = canvas.getContext('2d')!
      // JPEG 无透明通道，先铺白底避免透明区变黑
      if (format.value === 'jpeg') {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      ctx.drawImage(bmp, 0, 0)
      drawWatermark(ctx, canvas.width, canvas.height)
      const blob = await canvasToBlob(canvas, mime, format.value === 'jpeg' ? JPEG_QUALITY : undefined)
      return { name: outputName(img.name, blob.type || mime, NAME_SUFFIX), blob, width: canvas.width, height: canvas.height }
    } finally {
      bmp.close()
      releaseCanvas(canvas)
    }
  })
}

// 任何水印参数变化都重画预览
watch([text, mode, position, sizePct, color, opacity, rotation, gapX, gapY, stagger], redraw)

onBeforeUnmount(() => {
  images.value.forEach((i) => i.release())
  if (previewBase) releaseCanvas(previewBase)
  previewBase = null
})
</script>

<template>
  <div class="tool-page">
    <tool-group :title="`选择图片（最多 ${MAX_PICK} 张，已选 ${images.length}）`">
      <canvas v-show="images.length" ref="previewEl" class="wm-preview" />
      <p v-if="!images.length" class="tool-hint">点底部「相册」或「拍照」选图，可以多选。</p>
      <van-button v-if="images.length" plain round :disabled="busy" @click="reset">清空已选</van-button>
      <p v-if="images.length" class="tool-hint wm-tip">预览按第一张图缩小绘制，导出时按原尺寸，效果等比一致。</p>
    </tool-group>

    <tool-group>
      <van-field v-model="text" label="水印文字" placeholder="如：仅供办理业务使用" maxlength="40" clearable />
      <van-cell-group :border="false">
        <van-cell title="模式" center>
          <template #value>
            <van-radio-group v-model="mode" direction="horizontal" class="is-radios">
              <van-radio name="single">单个</van-radio>
              <van-radio name="tile">全图平铺</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell title="颜色" center>
          <template #value><color-picker v-model="color" label="水印颜色" /></template>
        </van-cell>
        <van-cell title="字号" :value="`${sizePct}%（占短边）`" />
      </van-cell-group>
      <div class="is-slider"><van-slider v-model="sizePct" :min="FONT_RANGE.min" :max="FONT_RANGE.max" /></div>
      <van-cell title="透明度" :value="`${opacity}%`" />
      <div class="is-slider"><van-slider v-model="opacity" :min="OPACITY_RANGE.min" :max="OPACITY_RANGE.max" /></div>
      <van-cell title="旋转" :value="`${rotation}°`" />
      <div class="is-slider"><van-slider v-model="rotation" :min="ROTATION_RANGE.min" :max="ROTATION_RANGE.max" /></div>

      <template v-if="mode === 'single'">
        <van-cell title="位置" />
        <div class="wm-grid">
          <button
            v-for="(label, i) in POSITION_LABELS"
            :key="i"
            type="button"
            class="wm-grid__cell"
            :class="{ 'is-on': position === i }"
            @click="position = i"
          >
            {{ label }}
          </button>
        </div>
      </template>
      <template v-else>
        <van-cell title="横向间距" :value="`${gapX}%`" />
        <div class="is-slider"><van-slider v-model="gapX" :min="GAP_RANGE.min" :max="GAP_RANGE.max" /></div>
        <van-cell title="纵向间距" :value="`${gapY}%`" />
        <div class="is-slider"><van-slider v-model="gapY" :min="GAP_RANGE.min" :max="GAP_RANGE.max" /></div>
        <van-cell title="隔行错开" center>
          <template #right-icon><van-switch v-model="stagger" size="22" /></template>
        </van-cell>
      </template>

      <van-cell title="输出格式" center>
        <template #value>
          <van-radio-group v-model="format" direction="horizontal" class="is-radios">
            <van-radio name="jpeg">JPEG</van-radio>
            <van-radio name="png">PNG</van-radio>
          </van-radio-group>
        </template>
      </van-cell>
    </tool-group>

    <tool-group v-if="results.length" title="结果（点击预览）">
      <image-result-list :results="results" />
    </tool-group>

    <!-- 底部动作栏：相册 / 拍照追加图片，保存结果，主按钮生成水印图 -->
    <bottom-actions :actions="{ save: { disabled: !results.length || saving } }" album photo main :main-text="busy ? `处理中 ${progress}` : '生成水印图'" :disabled="{ album: busy, photo: busy, main: busy || !images.length || !text.trim() }" @album="add" @photo="shoot" @main="run" @save="saveAll" />
  </div>
</template>

<style lang="scss" scoped>
/* 预览：宽度自适应，底色用 surface 衬出白色水印 */
.wm-preview {
  display: block;
  max-width: 100%;
  max-height: 50vh;
  margin: 0 auto $space-3;
  border-radius: 8px;
  background: #888;
}

.wm-tip {
  margin-top: $space-2;
}

.is-radios {
  justify-content: flex-end;
}

.is-slider {
  padding: $space-2 $space-3 $space-3;
}


/* 九宫格位置选择 */
.wm-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: $space-2;
  padding: $space-2 $space-3 $space-3;
}

.wm-grid__cell {
  padding: $space-2 0;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: none;
  font-size: 13px;
  color: var(--c-text);

  &.is-on {
    border-color: var(--c-primary);
    color: var(--c-primary);
    font-weight: 600;
  }
}
</style>
