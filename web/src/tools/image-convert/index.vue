<script setup lang="ts">
// 图片格式转换：PNG / JPEG / WebP，JPEG 透明区填底色，可批量
import { onBeforeUnmount, ref } from 'vue'
import { showToast } from 'vant'
import ImageThumbList from '@/shared/ImageThumbList.vue'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { changeText, FORMAT_MIME, formatBytes, outputName, type OutputFormat } from '@/shared/image-calc'
import { canvasToBlob, drawScaled, loadBitmap, pickImages, releaseCanvas, webpEncodeSupported, type PickedImage } from '@/shared/image-io'

/** 单次最多选择张数 */
const MAX_PICK = 20
/** 默认质量（百分比） */
const QUALITY_DEFAULT = 90
/** 默认填充底色 */
const FILL_DEFAULT = '#ffffff'

/** 已选图片 */
const images = ref<PickedImage[]>([])
/** 目标格式 */
const format = ref<OutputFormat>('jpeg')
/** 质量（JPEG/WebP 有效） */
const quality = ref(QUALITY_DEFAULT)
/** JPEG 透明区填充色 */
const fill = ref(FILL_DEFAULT)
/** 当前 WebView 能否编码 WebP */
const webpOk = webpEncodeSupported()
/** 结果与批处理状态 */
const { results, busy, progress, saving, process, saveAll, clear } = useImageResults()

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

/** 开始转换 */
async function run(): Promise<void> {
  const target = !webpOk && format.value === 'webp' ? 'png' : format.value
  const mime = FORMAT_MIME[target]
  await process(images.value, async (img) => {
    const bmp = await loadBitmap(img)
    let canvas: HTMLCanvasElement | null = null
    try {
      canvas = drawScaled(bmp, bmp.width, bmp.height, target === 'jpeg' ? fill.value : undefined)
      const blob = await canvasToBlob(canvas, mime, target === 'png' ? undefined : quality.value / 100)
      return {
        name: outputName(img.name, blob.type),
        blob,
        width: bmp.width,
        height: bmp.height,
        note: `原图 ${formatBytes(img.size)}，${changeText(img.size, blob.size)}`,
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
        <van-cell title="目标格式" center>
          <template #value>
            <van-radio-group v-model="format" direction="horizontal" class="icv-radios">
              <van-radio name="png">PNG</van-radio>
              <van-radio name="jpeg">JPEG</van-radio>
              <van-radio name="webp" :disabled="!webpOk">WebP</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell v-if="format !== 'png'" title="质量" :value="`${quality}%`" />
      </van-cell-group>
      <div v-if="format !== 'png'" class="icv-slider"><van-slider v-model="quality" :min="10" :max="100" /></div>
      <van-cell-group v-if="format === 'jpeg'" :border="false">
        <van-cell title="透明区填充色" center>
          <template #value><input v-model="fill" class="icv-color" type="color" aria-label="填充色" /></template>
        </van-cell>
      </van-cell-group>
      <p class="tool-hint">导出图不含拍摄信息（EXIF）。{{ webpOk ? '' : '当前系统不支持编码 WebP。' }}</p>
    </div>

    <van-button type="primary" block round :loading="busy" :disabled="!images.length" @click="run">
      {{ busy ? `转换中 ${progress}` : '开始转换' }}
    </van-button>

    <div v-if="results.length" class="tool-card">
      <h3 class="tool-card__title">结果</h3>
      <image-result-list :results="results" />
      <van-button type="primary" plain block round :loading="saving" @click="saveAll">保存全部</van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.icv-radios {
  justify-content: flex-end;
}

/* 滑杆留出触控空间 */
.icv-slider {
  padding: $space-2 $space-3 $space-3;
}

/* 颜色选择框 */
.icv-color {
  width: 44px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: none;
}
</style>
