<script setup lang="ts">
// 拼豆图纸生成：选图 → 居中裁方 → 降采样成 N×N 格 → Lab 最近色映射 → 带格线色号的图纸 + 用量统计
import { computed, onBeforeUnmount, ref } from 'vue'
import { showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { baseName } from '@/shared/image-calc'
import { canvasToBlob, createCanvas, loadBitmap, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'
import { PALETTES } from './data'
import {
  buildLabPalette,
  clampGrid,
  contrastColor,
  cropSquare,
  downsample,
  GRID_MAX,
  GRID_MIN,
  GRID_PRESETS,
  legendLayout,
  MAJOR_EVERY,
  mapToPalette,
  patternLayout,
  SAMPLE_PER_CELL,
  usageStats,
  type UsageRow,
} from './logic'

/** 自定义规格在单选里的取值 */
const CUSTOM = 'custom'
/** 输出文件名后缀 */
const NAME_SUFFIX = '-bead'
/** 图纸底色、细格线色、粗格线色、行列号色、色号字体 */
const PAPER = '#ffffff'
const LINE_THIN = 'rgba(0, 0, 0, 0.22)'
const LINE_MAJOR = 'rgba(0, 0, 0, 0.7)'
const LABEL_COLOR = '#555555'
const FONT_FAMILY = 'sans-serif'
/** 单格里色号字号 / 行列号字号 / 图例字号占单格边长的比例 */
const CODE_FONT_RATIO = 0.32
const LABEL_FONT_RATIO = 0.34
const LEGEND_FONT_RATIO = 0.4
const LEGEND_TITLE_RATIO = 0.5
/** 行列号标注间隔 */
const LABEL_EVERY = 5
/** 图例色块占单项高度比例 */
const SWATCH_RATIO = 0.7

/** 当前图片 */
const image = ref<PickedImage | null>(null)
/** 规格选择：29 / 52 / custom */
const gridChoice = ref<number | typeof CUSTOM>(GRID_PRESETS[0])
/** 自定义边长 */
const customN = ref(40)
/** 当前调色板 */
const paletteId = ref(PALETTES[0].id)
/** 用量统计 */
const stats = ref<UsageRow[]>([])
/** 结果与批处理状态 */
const { results, busy, saving, process, saveAll, clear } = useImageResults()

/** 实际网格边长 */
const gridN = computed(() => (gridChoice.value === CUSTOM ? clampGrid(customN.value) : (gridChoice.value as number)))
/** 当前调色板 */
const palette = computed(() => PALETTES.find((p) => p.id === paletteId.value) ?? PALETTES[0])
/** 总豆数 */
const totalBeads = computed(() => stats.value.reduce((s, r) => s + r.count, 0))

/** 选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ multiple: false, max: 1, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got.length) return
    image.value?.release()
    image.value = got[0]
    stats.value = []
    clear()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 画图纸 + 图例到画布 */
function drawPattern(n: number, indices: Uint16Array, rows: UsageRow[]): HTMLCanvasElement {
  const lay = patternLayout(n)
  const { cell, margin } = lay
  const leg = legendLayout(lay.width, rows.length, cell)
  const canvas = createCanvas(lay.width, lay.height + leg.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const colors = palette.value.colors
  // 色格 + 色号
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.round(cell * CODE_FONT_RATIO)}px ${FONT_FAMILY}`
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const c = colors[indices[y * n + x]]
      const px = margin + x * cell
      const py = margin + y * cell
      ctx.fillStyle = c.hex
      ctx.fillRect(px, py, cell, cell)
      ctx.fillStyle = contrastColor(c.hex)
      ctx.fillText(c.code, px + cell / 2, py + cell / 2)
    }
  }
  // 格线：细线 + 每 MAJOR_EVERY 格一条粗线
  for (let i = 0; i <= n; i++) {
    const major = i % MAJOR_EVERY === 0 || i === n
    ctx.strokeStyle = major ? LINE_MAJOR : LINE_THIN
    ctx.lineWidth = major ? 2 : 1
    const p = margin + i * cell
    ctx.beginPath()
    ctx.moveTo(p, margin)
    ctx.lineTo(p, margin + n * cell)
    ctx.moveTo(margin, p)
    ctx.lineTo(margin + n * cell, p)
    ctx.stroke()
  }
  // 行列号
  ctx.fillStyle = LABEL_COLOR
  ctx.font = `${Math.round(cell * LABEL_FONT_RATIO)}px ${FONT_FAMILY}`
  for (let i = 0; i < n; i++) {
    if (i !== 0 && (i + 1) % LABEL_EVERY !== 0) continue
    const c = margin + i * cell + cell / 2
    ctx.fillText(String(i + 1), c, margin / 2)
    ctx.fillText(String(i + 1), margin / 2, c)
  }
  // 图例
  if (leg.rows) {
    const top = lay.height
    ctx.textAlign = 'left'
    ctx.fillStyle = '#222222'
    ctx.font = `${Math.round(cell * LEGEND_TITLE_RATIO)}px ${FONT_FAMILY}`
    ctx.fillText(`颜色用量：${rows.length} 色，共 ${n * n} 颗`, margin, top + cell * 0.7)
    ctx.font = `${Math.round(cell * LEGEND_FONT_RATIO)}px ${FONT_FAMILY}`
    const sw = Math.round(leg.itemH * SWATCH_RATIO)
    rows.forEach((r, i) => {
      const x = margin + (i % leg.cols) * leg.itemW
      const y = top + Math.round(cell * 1.4) + Math.floor(i / leg.cols) * leg.itemH
      ctx.fillStyle = r.hex
      ctx.fillRect(x, y, sw, sw)
      ctx.strokeStyle = LINE_THIN
      ctx.lineWidth = 1
      ctx.strokeRect(x, y, sw, sw)
      ctx.fillStyle = '#222222'
      ctx.fillText(`${r.code} ${r.name} ×${r.count}`, x + sw + cell * 0.2, y + sw / 2)
    })
  }
  return canvas
}

/** 开始生成 */
async function run(): Promise<void> {
  const img = image.value
  if (!img) return
  const n = gridN.value
  await process([img], async (src) => {
    const bmp = await loadBitmap(src)
    const side = n * SAMPLE_PER_CELL
    const sample = createCanvas(side, side)
    let indices: Uint16Array
    try {
      const crop = cropSquare(bmp.width, bmp.height)
      const sctx = sample.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings)!
      sctx.imageSmoothingEnabled = true
      sctx.imageSmoothingQuality = 'high'
      sctx.drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, side, side)
      const data = sctx.getImageData(0, 0, side, side).data
      indices = mapToPalette(downsample(data, side, side, n, n), buildLabPalette(palette.value))
    } finally {
      bmp.close()
      releaseCanvas(sample)
    }
    const rows = usageStats(indices, palette.value)
    stats.value = rows
    const canvas = drawPattern(n, indices, rows)
    try {
      const blob = await canvasToBlob(canvas, 'image/png')
      return { name: `${baseName(src.name)}${NAME_SUFFIX}-${n}.png`, blob, width: canvas.width, height: canvas.height }
    } finally {
      releaseCanvas(canvas)
    }
  })
}

onBeforeUnmount(() => image.value?.release())
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">选择图片</h3>
      <img v-if="image" class="thumb" :src="image.url" :alt="image.name" />
      <van-button block plain round :disabled="busy" @click="choose">{{ image ? '换一张' : '选择图片' }}</van-button>
      <p class="tool-hint">图片会居中裁成正方形，再缩成方格图纸。</p>
    </div>

    <div class="tool-card">
      <van-cell-group :border="false">
        <van-cell title="规格" center>
          <template #value>
            <van-radio-group v-model="gridChoice" direction="horizontal" class="is-radios">
              <van-radio v-for="g in GRID_PRESETS" :key="g" :name="g">{{ g }}×{{ g }}</van-radio>
              <van-radio :name="CUSTOM">自定义</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell v-if="gridChoice === CUSTOM" :title="`边长 ${gridN} 格`" center />
      </van-cell-group>
      <div v-if="gridChoice === CUSTOM" class="is-slider"><van-slider v-model="customN" :min="GRID_MIN" :max="GRID_MAX" /></div>
      <van-cell-group :border="false">
        <van-cell title="调色板" center>
          <template #value>
            <select v-model="paletteId" class="is-select" aria-label="调色板">
              <option v-for="p in PALETTES" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </template>
        </van-cell>
      </van-cell-group>
      <p class="tool-hint">内置的是通用调色板，色号 A01… 是自编的，不是任何品牌的官方色号；品牌色号表以后再补。</p>
    </div>

    <van-button type="primary" block round :loading="busy" :disabled="!image" @click="run">{{ busy ? '生成中' : '生成图纸' }}</van-button>

    <div v-if="results.length" class="tool-card">
      <h3 class="tool-card__title">图纸（点击放大）</h3>
      <image-result-list :results="results" />
      <van-button type="primary" plain block round :loading="saving" @click="saveAll">保存</van-button>
    </div>

    <div v-if="stats.length" class="tool-card">
      <h3 class="tool-card__title">颜色用量（{{ stats.length }} 色，共 {{ totalBeads }} 颗）</h3>
      <van-cell-group :border="false">
        <van-cell v-for="r in stats" :key="r.code" :title="`${r.code} ${r.name}`" :value="`${r.count} 颗`" center>
          <template #icon><span class="swatch" :style="{ background: r.hex }" /></template>
        </van-cell>
      </van-cell-group>
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

/* 已选图片缩略 */
.thumb {
  display: block;
  max-width: 100%;
  max-height: 180px;
  margin: 0 auto $space-3;
  border-radius: 8px;
}

/* 原生下拉 */
.is-select {
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  color: inherit;
  background: transparent;
}

/* 用量表色块 */
.swatch {
  flex: none;
  width: 20px;
  height: 20px;
  margin-right: $space-2;
  border: 1px solid var(--c-border);
  border-radius: 4px;
}
</style>
