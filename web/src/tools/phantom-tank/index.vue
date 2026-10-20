<script setup lang="ts">
// 幻影坦克：表图 + 里图合成一张 PNG，白底看到表图，黑底看到里图
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { useImageResults } from '@/shared/useImageResults'
import { fitMaxEdge } from '@/shared/image-calc'
import { canvasToBlob, createCanvas, loadBitmap, EDIT_BASIC, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'
import { clampContrast, composePhantom, CONTRAST_DEFAULT, CONTRAST_MAX, CONTRAST_MIN, coverRect, MAX_EDGE } from './logic'

/** 输出文件名前缀 */
const NAME_PREFIX = 'phantom'
/** 对比度滑杆步进的放大倍数（滑杆用整数，值 = 滑杆 / 倍数） */
const CONTRAST_SCALE = 100

/** 表图（白底可见） */
const surface = ref<PickedImage | null>(null)
/** 里图（黑底可见） */
const inner = ref<PickedImage | null>(null)
/** 里图对比度（滑杆整数值） */
const contrastRaw = ref(CONTRAST_DEFAULT * CONTRAST_SCALE)
/** 预览背景：white / black */
const previewBg = ref<'white' | 'black'>('white')
/** 预览背景选项 */
const PREVIEW_BG_OPTIONS: CellOption[] = [
  { value: 'white', label: '白底' },
  { value: 'black', label: '黑底' },
]
/** 结果与批处理状态 */
const { results, busy, saving, process, saveAll } = useImageResults()

/** 当前对比度 */
const contrast = computed(() => clampContrast(contrastRaw.value / CONTRAST_SCALE))
/** 预览背景色 */
const bgColor = computed(() => (previewBg.value === 'white' ? '#ffffff' : '#000000'))

/** 选一张图放进指定槽位 */
async function choose(slot: 'surface' | 'inner'): Promise<void> {
  try {
    const [got] = await pickImages({ edit: EDIT_BASIC, multiple: false, max: 1, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got) return
    const target = slot === 'surface' ? surface : inner
    target.value?.release()
    target.value = got
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 把位图按 cover 铺满画布，先铺白底去透明，返回像素数据 */
function readPixels(bmp: ImageBitmap, w: number, h: number): Uint8ClampedArray {
  const canvas = createCanvas(w, h)
  try {
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const r = coverRect(bmp.width, bmp.height, w, h)
    ctx.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, w, h)
    return ctx.getImageData(0, 0, w, h).data
  } finally {
    releaseCanvas(canvas)
  }
}

/** 合成：尺寸以表图为准（最长边不超过 MAX_EDGE），里图按 cover 裁剪对齐 */
async function run(): Promise<void> {
  const a = surface.value
  const b = inner.value
  if (!a || !b) return
  await process([null], async () => {
    const size = fitMaxEdge(a.width || 1, a.height || 1, MAX_EDGE)
    let pixelsA: Uint8ClampedArray
    let pixelsB: Uint8ClampedArray
    // 一次只解码一张，读完立刻关位图
    const bmpA = await loadBitmap(a)
    try {
      pixelsA = readPixels(bmpA, size.width, size.height)
    } finally {
      bmpA.close()
    }
    const bmpB = await loadBitmap(b)
    try {
      pixelsB = readPixels(bmpB, size.width, size.height)
    } finally {
      bmpB.close()
    }
    const out = composePhantom(pixelsA, pixelsB, { contrast: contrast.value })
    const canvas = createCanvas(size.width, size.height)
    try {
      const img = canvas.getContext('2d')!.createImageData(size.width, size.height)
      img.data.set(out)
      canvas.getContext('2d')!.putImageData(img, 0, 0)
      const blob = await canvasToBlob(canvas, 'image/png')
      return { name: `${NAME_PREFIX}_${Date.now()}.png`, blob, width: size.width, height: size.height }
    } finally {
      releaseCanvas(canvas)
    }
  })
}

onBeforeUnmount(() => {
  surface.value?.release()
  inner.value?.release()
})
</script>

<template>
  <div class="tool-page">
    <tool-group title="表图与里图">
      <div class="pt-slots">
        <div class="pt-slot">
          <div class="pt-slot__box" @click="choose('surface')">
            <img v-if="surface" class="pt-slot__img" :src="surface.url" alt="表图" />
            <span v-else>选表图</span>
          </div>
          <div class="pt-slot__label">表图（白底可见）</div>
        </div>
        <div class="pt-slot">
          <div class="pt-slot__box" @click="choose('inner')">
            <img v-if="inner" class="pt-slot__img" :src="inner.url" alt="里图" />
            <span v-else>选里图</span>
          </div>
          <div class="pt-slot__label">里图（黑底可见）</div>
        </div>
      </div>
      <van-cell title="里图对比度" :value="contrast.toFixed(2)" />
      <div class="is-slider">
        <van-slider v-model="contrastRaw" :min="CONTRAST_MIN * CONTRAST_SCALE" :max="CONTRAST_MAX * CONTRAST_SCALE" />
      </div>
      <p class="tool-hint">输出尺寸跟随表图（最长边不超过 {{ MAX_EDGE }}），里图会居中裁剪铺满。两张图的亮度各只用一半范围，对比度会降低，里图暗部看不清时可调高对比度。</p>
    </tool-group>

    <tool-group v-if="results.length" title="效果预览">
      <cell-picker :model-value="previewBg" title="预览背景" :options="PREVIEW_BG_OPTIONS" @update:model-value="previewBg = $event as 'white' | 'black'" />
      <div class="pt-stage" :style="{ background: bgColor }">
        <img class="pt-stage__img" :src="results[0].url" alt="幻影坦克预览" />
      </div>
      <image-result-list :results="results" />
      <p class="tool-hint pt-tip">发给别人要选“原图”发送：微信、QQ 压缩或转 JPG 后透明信息会丢，效果就没了。</p>
    </tool-group>

    <!-- 底部动作栏：两个槽位各自点图选图，这里只放保存与主按钮合成 -->
    <bottom-actions :actions="{ save: { disabled: !results.length || saving, text: '保存 PNG' } }" main :main-text="busy ? '合成中' : '合成'" :disabled="{ main: busy || !surface || !inner }" @main="run" @save="saveAll" />
  </div>
</template>

<style lang="scss" scoped>
.pt-slots {
  display: flex;
  gap: $space-3;
  margin-bottom: $space-3;
}

.pt-slot {
  flex: 1;
  min-width: 0;
}

/* 选图框 */
.pt-slot__box {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 140px;
  overflow: hidden;
  border: 1px dashed var(--c-border);
  border-radius: 10px;
  background: var(--c-surface-active);
  font-size: 14px;
  color: var(--c-text-muted);
  cursor: pointer;
}

.pt-slot__img {
  max-width: 100%;
  max-height: 100%;
}

.pt-slot__label {
  margin-top: $space-1;
  font-size: 12px;
  text-align: center;
  color: var(--c-text-muted);
}

.is-slider {
  padding: $space-2 $space-3 $space-3;
}

/* 预览舞台：背景在白/黑间切换 */
.pt-stage {
  display: flex;
  justify-content: center;
  margin-bottom: $space-3;
  padding: $space-3;
  border: 1px solid var(--c-border);
  border-radius: 10px;
}

.pt-stage__img {
  max-width: 100%;
  max-height: 50vh;
}

.pt-tip {
  margin-top: $space-2;
}
</style>
