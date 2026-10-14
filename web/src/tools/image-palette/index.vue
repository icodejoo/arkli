<script setup lang="ts">
// 取色器：提取图片主色（median-cut），点图任意位置取色，HEX/RGB 一键复制
import { onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { fitMaxEdge } from '@/shared/image-calc'
import { drawScaled, loadBitmap, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'
import {
  getPixel,
  medianCut,
  PALETTE_DEFAULT,
  PALETTE_MAX,
  PALETTE_MIN,
  pointToPixel,
  readableTextColor,
  SAMPLE_MAX_EDGE,
  toHex,
  toRgbText,
  type PaletteColor,
  type Rgb,
} from './logic'

/** 当前图片 */
const image = ref<PickedImage | null>(null)
/** 主色数量 */
const count = ref(PALETTE_DEFAULT)
/** 主色结果 */
const palette = ref<PaletteColor[]>([])
/** 点选的颜色 */
const picked = ref<Rgb | null>(null)
/** 解析中 */
const loading = ref(false)

/** 取样数据：缩小后的 RGBA，用于取点与算主色（≤256px，占用很小） */
let sample: { data: Uint8ClampedArray; width: number; height: number } | null = null

/** 选图并解码取样 */
async function choose(): Promise<void> {
  try {
    const [got] = await pickImages({ multiple: false, max: 1, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got) return
    loading.value = true
    image.value?.release()
    image.value = got
    picked.value = null
    palette.value = []
    sample = null
    const bmp = await loadBitmap(got)
    try {
      const size = fitMaxEdge(bmp.width, bmp.height, SAMPLE_MAX_EDGE)
      const canvas = drawScaled(bmp, size.width, size.height)
      sample = { data: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height }
      releaseCanvas(canvas)
    } finally {
      bmp.close()
    }
    extract()
  } catch (e) {
    showFailToast((e as { message?: string }).message ?? '读取图片失败')
  } finally {
    loading.value = false
  }
}

/** 按当前数量重算主色 */
function extract(): void {
  palette.value = sample ? medianCut(sample.data, count.value) : []
}

/** 点击图片取色 */
function onTap(e: MouseEvent): void {
  if (!sample) return
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const p = pointToPixel(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, sample.width, sample.height)
  if (!p) return
  const c = getPixel(sample.data, sample.width, sample.height, p.x, p.y)
  if (c) picked.value = c
}

/** 复制文本并反馈 */
async function copy(text: string): Promise<void> {
  if (await copyText(text)) showSuccessToast(`已复制 ${text}`)
  else showFailToast('复制失败')
}

onBeforeUnmount(() => image.value?.release())
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">选择图片（点图可取色）</h3>
      <div v-if="image" class="pal-view">
        <img class="pal-img" :src="image.url" alt="待取色图片" draggable="false" @click="onTap" />
      </div>
      <van-button block plain round :loading="loading" @click="choose">{{ image ? '换一张' : '选择图片' }}</van-button>
    </div>

    <div v-if="picked" class="tool-card">
      <h3 class="tool-card__title">点选的颜色</h3>
      <div class="pal-picked">
        <span class="pal-swatch" :style="{ background: toHex(picked) }" />
        <div class="pal-codes">
          <van-button size="small" plain @click="copy(toHex(picked))">{{ toHex(picked) }}</van-button>
          <van-button size="small" plain @click="copy(toRgbText(picked))">{{ toRgbText(picked) }}</van-button>
        </div>
      </div>
    </div>

    <div v-if="image" class="tool-card">
      <h3 class="tool-card__title">主色（{{ count }} 种）</h3>
      <div class="is-slider"><van-slider v-model="count" :min="PALETTE_MIN" :max="PALETTE_MAX" @change="extract" /></div>
      <ul class="pal-list">
        <li
          v-for="(c, i) in palette"
          :key="i"
          class="pal-item"
          :style="{ background: toHex(c), color: readableTextColor(c) }"
          @click="copy(toHex(c))"
        >
          <span class="pal-item__hex">{{ toHex(c) }}</span>
          <span class="pal-item__rgb">{{ toRgbText(c) }}</span>
          <span class="pal-item__ratio">{{ Math.round(c.ratio * 100) }}%</span>
        </li>
      </ul>
      <p class="tool-hint">点色块复制 HEX；占比按取样缩略图的像素统计。</p>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 图片区：点按取色 */
.pal-view {
  margin-bottom: $space-3;
  overflow: hidden;
  border-radius: 8px;
  background: var(--c-surface-active);
  cursor: crosshair;
}

/* 不用 object-fit，保证元素矩形就是图片矩形，点击坐标才准 */
.pal-img {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  margin: 0 auto;
  user-select: none;
}

.pal-picked {
  display: flex;
  align-items: center;
  gap: $space-3;
}

.pal-swatch {
  flex: none;
  width: 56px;
  height: 56px;
  border: 1px solid var(--c-border);
  border-radius: 10px;
}

.pal-codes {
  display: flex;
  flex-direction: column;
  gap: $space-2;
  align-items: flex-start;
}

.is-slider {
  padding: $space-2 $space-3 $space-3;
}

.pal-list {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: $space-2;
  margin: 0 0 $space-3;
  padding: 0;
  list-style: none;
}

.pal-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: $space-3;
  border: 1px solid var(--c-border);
  border-radius: 10px;
  font-size: 12px;
  cursor: pointer;
}

.pal-item__hex {
  font-size: 15px;
  font-weight: 600;
}

.pal-item__ratio {
  opacity: 0.8;
}
</style>
