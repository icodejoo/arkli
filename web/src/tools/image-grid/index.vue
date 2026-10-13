<script setup lang="ts">
// 九宫格切图：选网格规格，可先居中裁成正方形，预览切线后逐张导出
import { computed, onBeforeUnmount, ref } from 'vue'
import { showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { baseName, FORMAT_MIME, gridCells, mimeToExt } from '@/shared/image-calc'
import { canvasToBlob, createCanvas, ImageTooLargeError, loadBitmap, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'

/** 网格规格：键为 `行x列` */
const GRID_PRESETS = ['3x3', '2x2', '1x3', '3x1', '2x3', '3x2']
/** 输出 JPEG 质量 */
const JPEG_QUALITY = 0.92
/** 文件名与序号之间的分隔符 */
const INDEX_SEP = '_'

/** 当前图片 */
const image = ref<PickedImage | null>(null)
/** 网格规格 */
const grid = ref('3x3')
/** 是否先居中裁成正方形 */
const square = ref(true)
/** 输出格式 */
const format = ref<'png' | 'jpeg'>('png')
/** 结果与批处理状态 */
const { results, busy, progress, saving, process, saveAll, clear } = useImageResults()

/** 行数 */
const rows = computed(() => Number(grid.value.split('x')[0]))
/** 列数 */
const cols = computed(() => Number(grid.value.split('x')[1]))
/** 预览切线的格子（仅用于渲染） */
const previewCells = computed(() => Array.from({ length: rows.value * cols.value }, (_, i) => i))
/** 预览容器样式：网格列行 */
const overlayStyle = computed(() => ({
  gridTemplateColumns: `repeat(${cols.value}, 1fr)`,
  gridTemplateRows: `repeat(${rows.value}, 1fr)`,
}))

/** 选图（单张） */
async function choose(): Promise<void> {
  try {
    const [got] = await pickImages({ multiple: false, max: 1, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got) return
    image.value?.release()
    image.value = got
    clear()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 开始切图：只解码一次，逐格画到小画布再导出 */
async function run(): Promise<void> {
  const img = image.value
  if (!img) return
  let bmp: ImageBitmap
  try {
    bmp = await loadBitmap(img)
  } catch (e) {
    showToast(e instanceof ImageTooLargeError ? '图片过大，请先缩小' : '图片读取失败')
    return
  }
  const mime = FORMAT_MIME[format.value]
  const { cells } = gridCells(bmp.width, bmp.height, rows.value, cols.value, square.value)
  try {
    await process(cells, async (cell) => {
      const canvas = createCanvas(cell.w, cell.h)
      try {
        const ctx = canvas.getContext('2d')!
        // JPEG 无透明，先垫白底
        if (format.value === 'jpeg') {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, cell.w, cell.h)
        }
        ctx.drawImage(bmp, cell.x, cell.y, cell.w, cell.h, 0, 0, cell.w, cell.h)
        const blob = await canvasToBlob(canvas, mime, format.value === 'jpeg' ? JPEG_QUALITY : undefined)
        return {
          name: `${baseName(img.name)}${INDEX_SEP}${cell.index}.${mimeToExt(blob.type)}`,
          blob,
          width: cell.w,
          height: cell.h,
          note: `第 ${cell.row + 1} 行 第 ${cell.col + 1} 列`,
        }
      } finally {
        releaseCanvas(canvas)
      }
    })
  } finally {
    bmp.close()
  }
}

onBeforeUnmount(() => image.value?.release())
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">选择图片</h3>
      <div v-if="image" class="ig-preview" :class="{ 'ig-preview--square': square }">
        <img class="ig-preview__img" :src="image.url" :alt="image.name" />
        <div class="ig-preview__grid" :style="overlayStyle">
          <i v-for="n in previewCells" :key="n" class="ig-preview__cell" />
        </div>
      </div>
      <p v-if="image" class="tool-hint ig-meta">{{ image.name }} · {{ image.width }}×{{ image.height }}</p>
      <van-button block plain round :disabled="busy" @click="choose">{{ image ? '换一张' : '选择图片' }}</van-button>
    </div>

    <div class="tool-card">
      <van-cell-group :border="false">
        <van-cell title="规格" center>
          <template #value>
            <van-radio-group v-model="grid" direction="horizontal" class="ig-radios">
              <van-radio v-for="g in GRID_PRESETS" :key="g" :name="g">{{ g.replace('x', '×') }}</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell title="居中裁成正方形" center>
          <template #right-icon><van-switch v-model="square" size="22" /></template>
        </van-cell>
        <van-cell title="输出格式" center>
          <template #value>
            <van-radio-group v-model="format" direction="horizontal" class="ig-radios">
              <van-radio name="png">PNG</van-radio>
              <van-radio name="jpeg">JPEG</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
      </van-cell-group>
      <p class="tool-hint">按行优先编号：_1 在左上。相册按时间排序，发朋友圈时按编号顺序选图即可。</p>
    </div>

    <van-button type="primary" block round :loading="busy" :disabled="!image" @click="run">
      {{ busy ? `切图中 ${progress}` : '开始切图' }}
    </van-button>

    <div v-if="results.length" class="tool-card">
      <h3 class="tool-card__title">结果（{{ results.length }} 张）</h3>
      <image-result-list :results="results" />
      <van-button type="primary" plain block round :loading="saving" @click="saveAll">保存全部</van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 预览框：图片原比例铺满宽度，切线盖在上面 */
.ig-preview {
  position: relative;
  margin-bottom: $space-2;
  overflow: hidden;
  line-height: 0;
  border-radius: 8px;
  background: var(--c-surface-active);

  /* 正方形裁剪：用 padding-top 撑出 1:1，图片居中铺满 */
  &--square {
    height: 0;
    padding-top: 100%;
  }
}

.ig-preview__img {
  display: block;
  width: 100%;

  .ig-preview--square & {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    object-fit: cover;
  }
}

/* 切线层：与图片等大的网格，每格描白边加深色外圈，亮暗背景都看得见 */
.ig-preview__grid {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
}

.ig-preview__cell {
  border: 1px dashed rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
}

.ig-meta {
  margin: 0 0 $space-2;
}

.ig-radios {
  justify-content: flex-end;
  row-gap: $space-2;
}
</style>
