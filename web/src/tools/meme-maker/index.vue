<script setup lang="ts">
// 表情包制作：在图片或纯色底上加字（经典上下字 + 可拖动文字层），导出 PNG/JPEG，或抖动/闪烁 GIF
import ColorPicker from '@/shared/ColorPicker.vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { fitMaxEdge, FORMAT_MIME, type Size } from '@/shared/image-calc'
import { canvasToBlob, createCanvas, drawScaled, loadBitmap, pickImages, releaseCanvas } from '@/shared/image-io'
import { GifWriter } from '../gif-tool/gif-encoder'
import { animFrames, CLASSIC_BASE_PCT, hitLayer, moveLayer, ratioSize, type MemePreset, type TextLayer } from './logic'
import { drawMeme, makeMeasure, type MemeScene } from './render'

/** 底图工作尺寸的长边上限（像素） */
const WORK_EDGE = 1080
/** 纯色底的长边（像素） */
const SOLID_EDGE = 720
/** JPEG 输出质量 */
const JPEG_QUALITY = 0.92
/** 默认底色 */
const BG_DEFAULT = '#ffffff'
/** 新文字层默认文字 */
const NEW_LAYER_TEXT = '文字'
/** 新文字层默认字号（占宽度百分比） */
const NEW_LAYER_PCT = 10
/** 文字层字号可调范围（百分比） */
const LAYER_PCT_MIN = 3
const LAYER_PCT_MAX = 30
/** 描边宽度可调上限（占字号百分比） */
const STROKE_PCT_MAX = 30
/** 新文字层默认描边（占字号百分比） */
const NEW_STROKE_PCT = 12
/** 经典字幕字号可调范围（百分比） */
const CLASSIC_PCT_MIN = 5
const CLASSIC_PCT_MAX = 18
/** 输出文件名前缀 */
const NAME_PREFIX = 'meme'
/** 纯色底比例选项 */
const RATIOS: Array<{ key: string; label: string; w: number; h: number }> = [
  { key: '1:1', label: '1:1', w: 1, h: 1 },
  { key: '4:3', label: '4:3', w: 4, h: 3 },
  { key: '16:9', label: '16:9', w: 16, h: 9 },
  { key: '9:16', label: '9:16', w: 9, h: 16 },
]
/** GIF 长边选项 */
const GIF_EDGES = [240, 360, 480]

/** 底图来源：图片或纯色 */
const baseMode = ref<'image' | 'solid'>('solid')
/** 已缩到工作尺寸的底图（不放进响应式深层） */
const baseCanvas = shallowRef<HTMLCanvasElement | null>(null)
/** 底色 */
const bgColor = ref(BG_DEFAULT)
/** 纯色底比例 */
const ratioKey = ref('1:1')
/** 顶部字幕 */
const topText = ref('')
/** 底部字幕 */
const bottomText = ref('')
/** 经典字幕字号（占宽度百分比） */
const classicPct = ref(CLASSIC_BASE_PCT)
/** 自由文字层 */
const layers = ref<TextLayer[]>([])
/** 选中的文字层 id */
const selectedId = ref<number | null>(null)
/** 动效预设 */
const preset = ref<MemePreset>('none')
/** GIF 长边 */
const gifEdge = ref(GIF_EDGES[1])
/** 静态输出格式 */
const format = ref<'png' | 'jpeg'>('png')
/** 导出结果 */
const { results, busy, progress, saving, process, saveAll, clear } = useImageResults()
/** GIF 导出进度文案 */
const gifText = ref('')
/** 预览画布 */
const cv = ref<HTMLCanvasElement | null>(null)
/** 文字层自增编号 */
let layerSeq = 0
/** 重绘是否已排队 */
let redrawQueued = false
/** 正在拖动的文字层与上一次指针位置 */
let drag: { id: number; x: number; y: number } | null = null

/** 当前画布尺寸 */
const work = computed<Size>(() => {
  if (baseMode.value === 'image' && baseCanvas.value) return { width: baseCanvas.value.width, height: baseCanvas.value.height }
  const r = RATIOS.find((x) => x.key === ratioKey.value) ?? RATIOS[0]
  return ratioSize(r.w, r.h, SOLID_EDGE)
})
/** 选中的文字层 */
const selected = computed(() => layers.value.find((l) => l.id === selectedId.value) ?? null)

/** 汇总当前内容给绘制函数 */
function scene(): MemeScene {
  return {
    base: baseMode.value === 'image' ? baseCanvas.value : null,
    bgColor: bgColor.value,
    top: topText.value,
    bottom: bottomText.value,
    classicSizePct: classicPct.value,
    layers: layers.value,
  }
}

/** 重绘预览（合并同一帧内的多次请求） */
function redraw(): void {
  if (redrawQueued) return
  redrawQueued = true
  requestAnimationFrame(() => {
    redrawQueued = false
    const c = cv.value
    if (!c) return
    const { width, height } = work.value
    if (c.width !== width) c.width = width
    if (c.height !== height) c.height = height
    drawMeme(c.getContext('2d')!, width, height, scene(), undefined, selectedId.value)
  })
}

watch([layers, selectedId, topText, bottomText, classicPct, bgColor, baseMode, baseCanvas, ratioKey], redraw, { deep: true })
onMounted(redraw)

/** 选择底图：解码后缩到工作尺寸，原位图立刻关闭 */
async function pickBase(): Promise<void> {
  try {
    const got = await pickImages({ multiple: false, max: 1 })
    if (!got.length) return
    const img = got[0]
    let bmp: ImageBitmap | null = null
    try {
      bmp = await loadBitmap(img)
      const t = fitMaxEdge(bmp.width, bmp.height, WORK_EDGE)
      const next = drawScaled(bmp, t.width, t.height)
      if (baseCanvas.value) releaseCanvas(baseCanvas.value)
      baseCanvas.value = next
      baseMode.value = 'image'
      clear()
    } finally {
      bmp?.close()
      img.release()
    }
  } catch (e) {
    showToast((e as { message?: string }).message ?? '读取图片失败')
  }
}

/** 添加一个文字层并选中，位置略错开 */
function addLayer(): void {
  const n = layers.value.length
  const l: TextLayer = {
    id: ++layerSeq,
    text: NEW_LAYER_TEXT,
    x: 0.5,
    y: Math.min(0.8, 0.5 + n * 0.08),
    sizePct: NEW_LAYER_PCT,
    color: '#ffffff',
    strokeColor: '#000000',
    strokePct: NEW_STROKE_PCT,
  }
  layers.value.push(l)
  selectedId.value = l.id
}

/** 删除选中的文字层 */
function removeSelected(): void {
  layers.value = layers.value.filter((l) => l.id !== selectedId.value)
  selectedId.value = null
}

/** 指针位置换算成画布像素 */
function toCanvas(e: PointerEvent): { x: number; y: number } {
  const c = cv.value!
  const r = c.getBoundingClientRect()
  return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height }
}

/** 按下：命中文字层就选中并开始拖动，没命中取消选中 */
function onDown(e: PointerEvent): void {
  const c = cv.value
  if (!c) return
  const p = toCanvas(e)
  const idx = hitLayer(layers.value, p.x, p.y, c.width, c.height, makeMeasure(c.getContext('2d')!))
  if (idx < 0) {
    selectedId.value = null
    return
  }
  const l = layers.value[idx]
  selectedId.value = l.id
  drag = { id: l.id, x: p.x, y: p.y }
  c.setPointerCapture(e.pointerId)
}

/** 移动：拖动选中的文字层 */
function onMove(e: PointerEvent): void {
  const c = cv.value
  if (!drag || !c) return
  const p = toCanvas(e)
  const l = layers.value.find((x) => x.id === drag!.id)
  if (l) Object.assign(l, moveLayer(l, p.x - drag.x, p.y - drag.y, c.width, c.height))
  drag = { id: drag.id, x: p.x, y: p.y }
}

/** 抬起：结束拖动 */
function onUp(): void {
  drag = null
}

/** 让出一轮事件循环 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 导出：无动效出静态图，有动效出 GIF */
async function run(): Promise<void> {
  const { width, height } = work.value
  const sc = scene()
  await process([0], async () => {
    if (preset.value === 'none') {
      const canvas = createCanvas(width, height)
      try {
        drawMeme(canvas.getContext('2d')!, width, height, sc)
        const blob = await canvasToBlob(canvas, FORMAT_MIME[format.value], format.value === 'jpeg' ? JPEG_QUALITY : undefined)
        return { name: `${NAME_PREFIX}_${Date.now()}.${format.value === 'jpeg' ? 'jpg' : 'png'}`, blob, width, height }
      } finally {
        releaseCanvas(canvas)
      }
    }
    const g = fitMaxEdge(width, height, gifEdge.value)
    const frames = animFrames(preset.value, g.width)
    const writer = new GifWriter({ width: g.width, height: g.height, loop: 0 })
    for (let i = 0; i < frames.length; i++) {
      gifText.value = `${i + 1}/${frames.length}`
      const canvas = createCanvas(g.width, g.height)
      try {
        const ctx = canvas.getContext('2d')!
        drawMeme(ctx, g.width, g.height, sc, frames[i])
        writer.addFrame(ctx.getImageData(0, 0, g.width, g.height).data, frames[i].delayCs)
      } finally {
        releaseCanvas(canvas)
      }
      await tick()
    }
    gifText.value = ''
    const blob = new Blob([writer.finish() as BlobPart], { type: 'image/gif' })
    return { name: `${NAME_PREFIX}_${Date.now()}.gif`, blob, width: g.width, height: g.height, note: `${frames.length} 帧循环` }
  })
  gifText.value = ''
}

onBeforeUnmount(() => {
  if (baseCanvas.value) releaseCanvas(baseCanvas.value)
})
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">底图</h3>
      <van-cell-group :border="false">
        <van-cell title="来源" center>
          <template #value>
            <van-radio-group v-model="baseMode" direction="horizontal" class="is-radios">
              <van-radio name="solid">纯色底</van-radio>
              <van-radio name="image" :disabled="!baseCanvas">图片</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell v-if="baseMode === 'solid'" title="比例" center>
          <template #value>
            <van-radio-group v-model="ratioKey" direction="horizontal" class="is-radios">
              <van-radio v-for="r in RATIOS" :key="r.key" :name="r.key">{{ r.label }}</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell title="底色" center>
          <template #value><color-picker v-model="bgColor" label="底色" /></template>
        </van-cell>
      </van-cell-group>
      <van-button block plain round @click="pickBase">{{ baseCanvas ? '换一张图片' : '选择图片' }}</van-button>
    </div>

    <div class="tool-card">
      <canvas
        ref="cv"
        class="meme__canvas"
        aria-label="表情包预览，可拖动文字"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      />
      <p class="tool-hint">{{ work.width }}×{{ work.height }}，文字层可直接在图上拖动</p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">上下字幕</h3>
      <van-field v-model="topText" label="上方" placeholder="顶部文字，太长自动缩小、换行" clearable />
      <van-field v-model="bottomText" label="下方" placeholder="底部文字" clearable />
      <van-cell title="字号" :value="`${classicPct}%`" />
      <div class="is-slider"><van-slider v-model="classicPct" :min="CLASSIC_PCT_MIN" :max="CLASSIC_PCT_MAX" /></div>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">自由文字</h3>
      <div class="chips">
        <van-button
          v-for="(l, i) in layers"
          :key="l.id"
          size="small"
          round
          :type="l.id === selectedId ? 'primary' : 'default'"
          @click="selectedId = l.id"
        >
          {{ i + 1 }}. {{ l.text.split('\n')[0].slice(0, 6) || '空' }}
        </van-button>
        <van-button size="small" round plain icon="plus" @click="addLayer">加一段文字</van-button>
      </div>
      <template v-if="selected">
        <van-field v-model="selected.text" type="textarea" rows="2" autosize label="文字" placeholder="可换行" />
        <van-cell :title="`字号 ${selected.sizePct}%`" />
        <div class="is-slider"><van-slider v-model="selected.sizePct" :min="LAYER_PCT_MIN" :max="LAYER_PCT_MAX" /></div>
        <van-cell :title="`描边 ${selected.strokePct}%`" />
        <div class="is-slider"><van-slider v-model="selected.strokePct" :min="0" :max="STROKE_PCT_MAX" /></div>
        <van-cell title="颜色" center>
          <template #value>
            <color-picker v-model="selected.color" label="文字颜色" />
            <color-picker v-model="selected.strokeColor" label="描边颜色" />
          </template>
        </van-cell>
        <van-button size="small" plain type="danger" @click="removeSelected">删除这段文字</van-button>
      </template>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">导出</h3>
      <van-cell-group :border="false">
        <van-cell title="动效" center>
          <template #value>
            <van-radio-group v-model="preset" direction="horizontal" class="is-radios">
              <van-radio name="none">无</van-radio>
              <van-radio name="shake">抖动</van-radio>
              <van-radio name="blink">闪烁</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell v-if="preset === 'none'" title="格式" center>
          <template #value>
            <van-radio-group v-model="format" direction="horizontal" class="is-radios">
              <van-radio name="png">PNG</van-radio>
              <van-radio name="jpeg">JPEG</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell v-else title="GIF 长边" center>
          <template #value>
            <van-radio-group v-model="gifEdge" direction="horizontal" class="is-radios">
              <van-radio v-for="e in GIF_EDGES" :key="e" :name="e">{{ e }}</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
      </van-cell-group>
    </div>

    <van-button type="primary" block round :loading="busy" @click="run">
      {{ busy ? `生成中 ${gifText || progress}` : preset === 'none' ? '生成图片' : '生成 GIF' }}
    </van-button>

    <div v-if="results.length" class="tool-card">
      <h3 class="tool-card__title">结果（点击预览）</h3>
      <image-result-list :results="results" />
      <van-button type="primary" plain block round :loading="saving" @click="saveAll">保存</van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.is-radios {
  justify-content: flex-end;
}

/* 滑杆留出触控空间 */
.is-slider {
  padding: $space-2 $space-3 $space-3;
}


/* 预览画布：宽度铺满，禁用浏览器手势才能顺畅拖动文字 */
.meme__canvas {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 6px;
  background: repeating-conic-gradient(#0001 0 25%, transparent 0 50%) 0 0 / 16px 16px;
  touch-action: none;
}

/* 文字层选择条 */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  margin-bottom: $space-3;
}
</style>
