<script setup lang="ts">
// 图片压缩：质量 + 最长边 + 输出格式（JPEG/WebP），可批量，显示压缩前后体积
import { computed, onBeforeUnmount, ref } from 'vue'
import { showToast } from 'vant'
import ImageThumbList from '@/shared/ImageThumbList.vue'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { changeText, fitMaxEdge, FORMAT_MIME, formatBytes, outputName } from '@/shared/image-calc'
import { canvasToBlob, drawScaled, loadBitmap, pickImages, releaseCanvas, webpEncodeSupported, type PickedImage } from '@/shared/image-io'

/** 单次最多选择张数 */
const MAX_PICK = 20
/** 质量滑杆范围 */
const QUALITY_MIN = 10
const QUALITY_MAX = 100
/** 默认质量（百分比） */
const QUALITY_DEFAULT = 80
/** 最长边预设，0 表示不限 */
const EDGE_PRESETS = [0, 4096, 2048, 1080, 720]
/** 输出文件名后缀 */
const NAME_SUFFIX = '-min'
/** 输出格式：JPEG 或 WebP */
type CompressFormat = 'jpeg' | 'webp'

/** 已选图片 */
const images = ref<PickedImage[]>([])
/** 质量（10~100） */
const quality = ref(QUALITY_DEFAULT)
/** 最长边（0 不限） */
const maxEdge = ref(0)
/** 输出格式 */
const format = ref<CompressFormat>('jpeg')
/** 当前 WebView 能否编码 WebP */
const webpOk = webpEncodeSupported()
/** 结果与批处理状态 */
const { results, busy, progress, saving, process, saveAll, clear } = useImageResults()

/** 压缩前后总体积对比文案 */
const summary = computed(() => {
  const before = images.value.reduce((s, i) => s + i.size, 0)
  const after = results.value.reduce((s, r) => s + r.blob.size, 0)
  return results.value.length ? `${formatBytes(before)} → ${formatBytes(after)}（${changeText(before, after)}）` : ''
})

/** 添加图片 */
async function add(): Promise<void> {
  const room = MAX_PICK - images.value.length
  if (room <= 0) {
    showToast(`最多 ${MAX_PICK} 张`)
    return
  }
  try {
    const got = await pickImages({ multiple: true, max: room, onFailed: (f) => showToast(`${f.length} 张读取失败：${f[0].message}`) })
    images.value = images.value.concat(got)
    clear()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 移除第 i 张 */
function remove(i: number): void {
  images.value[i].release()
  images.value.splice(i, 1)
  clear()
}

/** 开始压缩 */
async function run(): Promise<void> {
  const mime = FORMAT_MIME[webpOk ? format.value : 'jpeg']
  await process(images.value, async (img) => {
    const bmp = await loadBitmap(img)
    let canvas: HTMLCanvasElement | null = null
    try {
      const t = fitMaxEdge(bmp.width, bmp.height, maxEdge.value)
      // JPEG 不支持透明，垫白底
      canvas = drawScaled(bmp, t.width, t.height, mime === FORMAT_MIME.jpeg ? '#ffffff' : undefined)
      const blob = await canvasToBlob(canvas, mime, quality.value / 100)
      return {
        name: outputName(img.name, blob.type, NAME_SUFFIX),
        blob,
        width: t.width,
        height: t.height,
        note: `压缩前 ${formatBytes(img.size)}，${changeText(img.size, blob.size)}`,
      }
    } finally {
      bmp.close()
      if (canvas) releaseCanvas(canvas)
    }
  })
}

onBeforeUnmount(() => images.value.forEach((i) => i.release()))
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">选择图片（最多 {{ MAX_PICK }} 张）</h3>
      <image-thumb-list :images="images" @remove="remove" />
      <van-button block plain round :disabled="busy" @click="add">{{ images.length ? '继续添加' : '选择图片' }}</van-button>
    </div>

    <div class="tool-card">
      <van-cell-group :border="false">
        <van-cell title="质量" :value="`${quality}%`" />
      </van-cell-group>
      <div class="ic-slider"><van-slider v-model="quality" :min="QUALITY_MIN" :max="QUALITY_MAX" /></div>
      <van-cell-group :border="false">
        <van-cell title="输出格式" center>
          <template #value>
            <van-radio-group v-model="format" direction="horizontal">
              <van-radio name="jpeg">JPEG</van-radio>
              <van-radio name="webp" :disabled="!webpOk">WebP</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell title="最长边" center>
          <template #value>
            <van-radio-group v-model="maxEdge" direction="horizontal" class="ic-edges">
              <van-radio v-for="e in EDGE_PRESETS" :key="e" :name="e">{{ e || '不限' }}</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
      </van-cell-group>
      <p class="tool-hint">导出图不含拍摄信息（EXIF）；透明区域转 JPEG 时填白底。</p>
    </div>

    <van-button type="primary" block round :loading="busy" :disabled="!images.length" @click="run">
      {{ busy ? `压缩中 ${progress}` : '开始压缩' }}
    </van-button>

    <div v-if="results.length" class="tool-card">
      <h3 class="tool-card__title">结果 {{ summary }}</h3>
      <image-result-list :results="results" />
      <van-button type="primary" plain block round :loading="saving" @click="saveAll">保存全部</van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 滑杆留出触控空间 */
.ic-slider {
  padding: $space-2 $space-3 $space-3;
}

/* 最长边选项较多，允许换行 */
.ic-edges {
  justify-content: flex-end;
  row-gap: $space-2;
}
</style>
