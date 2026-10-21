<script setup lang="ts">
// 拼豆图纸生成：选图 → 居中裁方 → 降采样成 N×N 格 → Lab 最近色映射 → 带格线色号的图纸 + 用量统计
import { computed, onBeforeUnmount, ref } from 'vue'
import { showFailToast, showImagePreview, showSuccessToast, showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import BottomActions from '@/shared/BottomActions.vue'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { cameraItemToPicked, captureCamera, clearCamera, isAlbum, isCancelled } from '@/native/camera'
import { isNativeAvailable } from '@/native/bridge'
import { useImageResults } from '@/shared/useImageResults'
import { baseName } from '@/shared/image-calc'
import { canvasToBlob, createCanvas, loadBitmap, EDIT_BASIC, pickImages, previewBlob, releaseCanvas, type PickedImage } from '@/shared/image-io'
import { GENERIC_PALETTE, PALETTES } from './data'
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
  percentText,
  usageText,
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
const paletteId = ref(GENERIC_PALETTE.id)
/** 用量统计 */
const stats = ref<UsageRow[]>([])
/** 结果与批处理状态 */
const { results, busy, saving, process, saveAll, clear } = useImageResults()
/** 生成报告弹窗是否打开 */
const reportOpen = ref(false)

/** 实际网格边长 */
const gridN = computed(() => (gridChoice.value === CUSTOM ? clampGrid(customN.value) : (gridChoice.value as number)))
/** 当前调色板 */
const palette = computed(() => PALETTES.find((p) => p.id === paletteId.value) ?? PALETTES[0])
/** 总豆数 */
const totalBeads = computed(() => stats.value.reduce((s, r) => s + r.count, 0))

/** 规格选项：预设 + 自定义 */
const gridOptions: CellOption[] = [...GRID_PRESETS.map((g) => ({ value: g, label: `${g}×${g}` })), { value: CUSTOM, label: '自定义' }]
/** 调色板选项 */
const paletteOptions: CellOption[] = PALETTES.map((p) => ({ value: p.id, label: p.name }))

/** 换上新图：释放旧图、清掉旧结果 */
function setImage(img: PickedImage): void {
  image.value?.release()
  image.value = img
  stats.value = []
  clear()
}

/** 统一报错 */
function fail(e: unknown, fallback: string): void {
  showToast((e as { message?: string }).message ?? fallback)
}

/** 相册选一张（无宿主时 input 兜底） */
async function fromAlbum(): Promise<void> {
  try {
    const got = await pickImages({ edit: EDIT_BASIC, multiple: false, max: 1, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got.length) setImage(got[0])
  } catch (e) {
    fail(e, '选图失败')
  }
}

/** 拍照：原生相机；相机里点相册转相册；无宿主退回 input 选图 */
async function fromCamera(): Promise<void> {
  try {
    if (!isNativeAvailable()) return await fromAlbum()
    const r = await captureCamera({ modes: ['photo', 'album'] })
    if (isCancelled(r)) return
    if (isAlbum(r)) return await fromAlbum()
    if (r.kind === 'image') setImage(cameraItemToPicked(r))
  } catch (e) {
    fail(e, '拍照失败')
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
  const made = await process([img], async (src) => {
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
  if (made) reportOpen.value = true
}

/** 预览放大图纸：宿主内走原生全屏，浏览器里回退 vant 预览 */
async function previewReport(): Promise<void> {
  const r = results.value[0]
  if (!r) return
  try {
    if (await previewBlob(r.blob, r.name)) return
  } catch {
    // 原生预览失败时回退
  }
  showImagePreview({ images: [r.url], closeable: true })
}

/** 复制颜色用量，一色一行 */
async function copyStats(): Promise<void> {
  if (await copyText(usageText(stats.value))) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}

/** 保存图纸到相册，成功后关闭弹窗 */
async function saveReport(): Promise<void> {
  if (await saveAll()) reportOpen.value = false
}

onBeforeUnmount(() => {
  image.value?.release()
  void clearCamera()
})
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <van-cell-group :border="false">
        <cell-picker v-model="gridChoice" title="规格" :options="gridOptions" :disabled="busy" />
        <van-cell v-if="gridChoice === CUSTOM" :title="`边长 ${gridN} 格`" center />
      </van-cell-group>
      <div v-if="gridChoice === CUSTOM" class="is-slider"><van-slider v-model="customN" :min="GRID_MIN" :max="GRID_MAX" /></div>
      <van-cell-group :border="false">
        <cell-picker v-model="paletteId" title="调色板" :options="paletteOptions" :disabled="busy" />
      </van-cell-group>
      <p class="tool-hint">内置的是通用调色板，色号 A01… 是自编的，不是任何品牌的官方色号；品牌色号表以后再补。</p>
    </tool-group>

    <img v-if="image" class="thumb" :src="image.url" :alt="image.name" />
    <p v-else class="tool-hint">点底部「相册」或「拍照」选一张图，会居中裁成正方形再缩成方格图纸。</p>

    <bottom-actions :main-loading="busy" album photo main :main-text="busy ? '生成中' : '生成图纸'" :disabled="{ album: busy, photo: busy, main: busy || !image }" @album="fromAlbum" @photo="fromCamera" @main="run" />

    <!-- 生成报告：满屏弹窗，顶部标题栏，底部「保存 + 预览」 -->
    <van-popup v-model:show="reportOpen" position="right" teleport="body" class="report" :style="{ width: '100%', height: '100%' }">
      <van-nav-bar title="生成报告" left-arrow safe-area-inset-top @click-left="reportOpen = false" />
      <div class="report__body tool-page">
        <img v-if="results[0]" class="report-img" :src="results[0].url" :alt="results[0].name" @click="previewReport" />
        <tool-group v-if="stats.length" :title="`颜色用量（${stats.length} 色，共 ${totalBeads} 颗）`">
          <van-cell-group :border="false">
            <van-cell v-for="r in stats" :key="r.code" :title="`${r.code} ${r.name}`" :value="`${r.count} 颗 · ${percentText(r.count, totalBeads)}`" center>
              <template #icon><span class="swatch" :style="{ background: r.hex }" /></template>
            </van-cell>
          </van-cell-group>
        </tool-group>
      </div>
      <bottom-actions :actions="{ copy: { disabled: !stats.length }, save: { disabled: saving } }" main main-text="预览" @main="previewReport" @copy="copyStats" @save="saveReport" />
    </van-popup>
  </div>
</template>

<style lang="scss" scoped>
/* 滑杆留出触控空间 */
.is-slider {
  padding: $space-2 $space-3 $space-3;
}

/* 已选图片预览：宽度铺满，高度自适应 */
.thumb {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 8px;
}

/* 报告弹窗：标题栏与底部栏不随内容滚动，只有中间 body 滚（popup 带 transform，fixed 会跟着它滚走） */
.report {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.report__body {
  flex: 1;
  min-height: 0;
  padding: $space-3;
  overflow-y: auto;
}

/* 报告里的图纸，宽度铺满 */
.report-img {
  display: block;
  width: 100%;
  border-radius: 8px;
  background: #fff;
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
