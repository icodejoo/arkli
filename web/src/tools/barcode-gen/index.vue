<script setup lang="ts">
// 条形码生成：EAN-13 / Code128 / Code39，实时画到 Canvas，可导出 PNG
import BottomActions from '@/shared/BottomActions.vue'
import { computed, nextTick, ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { canvasToBlob, saveBlob } from '@/shared/image-io'
import {
  BAR_HEIGHT_MAX,
  BAR_HEIGHT_MIN,
  BARCODE_KINDS,
  DEFAULT_BG,
  DEFAULT_FG,
  drawBarcode,
  encodeBarcode,
  layoutBarcode,
  SCALE_MAX,
  SCALE_MIN,
  type BarcodeKind,
  type DrawOptions,
} from './logic'

/** 导出文件名 */
const FILE_NAME = 'barcode.png'
/** 默认内容（按类型给示例） */
const SAMPLES: Record<BarcodeKind, string> = { ean13: '590123412345', code128: 'Arkli-2026', code39: 'ARKLI-39' }

/** 当前类型 */
const kind = ref<BarcodeKind>('ean13')
/** 输入内容 */
const text = ref(SAMPLES.ean13)
/** 每模块像素 */
const scale = ref(3)
/** 条高 */
const barHeight = ref(120)
/** 显示下方文字 */
const showText = ref(true)
/** 画布元素 */
const canvas = ref<HTMLCanvasElement | null>(null)
/** 保存中 */
const saving = ref(false)

/** 编码结果 */
const result = computed(() => encodeBarcode(kind.value, text.value))
/** 当前类型的输入提示 */
const hint = computed(() => BARCODE_KINDS.find((k) => k.id === kind.value)?.hint ?? '')
/** 错误提示：空输入只显示占位，不报错 */
const errorText = computed(() => (text.value && !result.value.ok ? result.value.error : ''))
/** 绘制选项 */
const drawOpts = computed<DrawOptions>(() => ({ scale: scale.value, barHeight: barHeight.value, showText: showText.value, fg: DEFAULT_FG, bg: DEFAULT_BG }))

/** 切类型时换成该类型的示例内容 */
function onKind(): void {
  text.value = SAMPLES[kind.value]
}

/** 重绘：先按尺寸设宽高（会清空画布）再画 */
async function redraw(): Promise<void> {
  await nextTick()
  const r = result.value
  const el = canvas.value
  if (!el || !r.ok) return
  const size = layoutBarcode(r.modules.length, drawOpts.value)
  el.width = size.width
  el.height = size.height
  const ctx = el.getContext('2d')
  if (ctx) drawBarcode(ctx, r, drawOpts.value)
}
watch([result, drawOpts], redraw, { flush: 'post', immediate: true })

/** 保存 PNG：宿主内走原生保存，浏览器里走下载 */
async function save(): Promise<void> {
  if (!canvas.value || !result.value.ok) return
  saving.value = true
  try {
    const blob = await canvasToBlob(canvas.value, 'image/png')
    const res = await saveBlob(blob, FILE_NAME)
    showSuccessToast(res.mode === 'native' ? '已保存到相册' : '已开始下载')
  } catch {
    showFailToast('保存失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="kind" type="card" @change="onKind">
      <van-tab v-for="k in BARCODE_KINDS" :key="k.id" :title="k.label" :name="k.id" />
    </van-tabs>

    <tool-group title="内容">
      <van-field v-model="text" clearable placeholder="输入条码内容" :error-message="errorText" />
      <p class="tool-hint">{{ hint }}</p>
    </tool-group>

    <tool-group v-if="result.ok" class="bc-preview">
      <canvas ref="canvas" class="bc-canvas" />
      <p class="tool-hint">{{ result.modules.length }} 个模块 · 内容 {{ result.label }}</p>
    </tool-group>
    <tool-group v-else-if="!text" class="bc-empty tool-hint">输入内容后，条形码会显示在这里</tool-group>

    <tool-group title="样式">
      <h3 class="tool-group__title">条宽：每模块 {{ scale }} px</h3>
      <van-slider v-model="scale" :min="SCALE_MIN" :max="SCALE_MAX" />
      <h3 class="tool-group__title bc-gap">条高：{{ barHeight }} px</h3>
      <van-slider v-model="barHeight" :min="BAR_HEIGHT_MIN" :max="BAR_HEIGHT_MAX" :step="10" />
      <van-cell title="显示下方文字" center class="bc-gap">
        <template #right-icon><van-switch v-model="showText" size="22" /></template>
      </van-cell>
    </tool-group>

    <bottom-actions main main-text="保存 PNG" :disabled="{ main: !result.ok || saving }" @main="save" />
  </div>
</template>

<style lang="scss" scoped>
.bc-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-2;
}
.bc-canvas {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--c-border);
  background: #fff;
}
.bc-empty {
  text-align: center;
}
.bc-gap {
  margin-top: $space-4;
}
</style>
