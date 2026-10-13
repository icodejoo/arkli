<script setup lang="ts">
// 二维码生成：输入文本实时画到 Canvas，可调纠错、边距、尺寸、颜色，导出 PNG
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { canvasToBlob, saveBlob } from '@/shared/image-io'
import {
  BORDER_MAX,
  BORDER_MIN,
  colorWarning,
  DEFAULT_BG,
  DEFAULT_FG,
  drawQr,
  ECC_OPTIONS,
  makeQr,
  parseHex,
  SIZE_MAX,
  SIZE_MIN,
  type EccLevel,
} from './logic'

/** 防抖毫秒数 */
const DEBOUNCE_MS = 150
/** 导出文件名 */
const FILE_NAME = 'qrcode.png'
/** 前景色预设 */
const FG_PRESETS = ['#000000', '#1e3a8a', '#166534', '#991b1b', '#6b21a8']
/** 背景色预设 */
const BG_PRESETS = ['#ffffff', '#f3f4f6', '#fef9c3', '#dbeafe']

/** 输入内容 */
const text = ref('')
/** 防抖后的内容 */
const settled = ref('')
/** 纠错等级 */
const ecc = ref<EccLevel>('M')
/** 边距（模块数） */
const border = ref(4)
/** 目标边长（像素） */
const size = ref(512)
/** 前景色输入 */
const fg = ref(DEFAULT_FG)
/** 背景色输入 */
const bg = ref(DEFAULT_BG)
/** 画布元素 */
const canvas = ref<HTMLCanvasElement | null>(null)
/** 实际画布边长 */
const pixels = ref(0)
/** 保存中 */
const saving = ref(false)
/** 防抖定时器 */
let debounce: ReturnType<typeof setTimeout> | undefined

/** 颜色输入是否都合法 */
const colorsValid = computed(() => !!parseHex(fg.value) && !!parseHex(bg.value))
/** 生成结果 */
const result = computed(() => makeQr(settled.value, ecc.value))
/** 空输入时不报错，只显示占位 */
const errorText = computed(() => (settled.value && !result.value.ok ? result.value.error : ''))
/** 对比度提示 */
const warning = computed(() => colorWarning(fg.value, bg.value))
/** 能不能画/导出 */
const canDraw = computed(() => result.value.ok && colorsValid.value)

watch(text, (v) => {
  clearTimeout(debounce)
  debounce = setTimeout(() => (settled.value = v), DEBOUNCE_MS)
})
onBeforeUnmount(() => clearTimeout(debounce))

/** 重绘：Canvas 实际像素由 drawQr 回传 */
async function redraw(): Promise<void> {
  await nextTick()
  const r = result.value
  const el = canvas.value
  if (!el || !r.ok || !colorsValid.value) return
  // 先算出边长再设宽高（设置宽高会清空画布）
  const probe = { fillStyle: '', fillRect() {} }
  const side = drawQr(probe, r.value, { size: size.value, border: border.value, fg: fg.value, bg: bg.value })
  el.width = side
  el.height = side
  const ctx = el.getContext('2d')
  if (!ctx) return
  drawQr(ctx, r.value, { size: size.value, border: border.value, fg: fg.value, bg: bg.value })
  pixels.value = side
}
watch([result, border, size, fg, bg], redraw, { flush: 'post' })

/** 保存 PNG：宿主内走原生保存，浏览器里走下载 */
async function save(): Promise<void> {
  if (!canvas.value || !canDraw.value) return
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
    <div class="tool-card">
      <h3 class="tool-card__title">内容</h3>
      <van-field
        v-model="text"
        type="textarea"
        rows="3"
        autosize
        clearable
        placeholder="输入文字或网址，如 https://example.com"
        :error-message="errorText"
      />
    </div>

    <div v-if="result.ok && colorsValid" class="tool-card qr-preview">
      <canvas ref="canvas" class="qr-canvas" />
      <p class="tool-hint">
        版本 {{ result.value.version }} · {{ result.value.size }}×{{ result.value.size }} 模块 · 输出 {{ pixels }}×{{ pixels }} px
      </p>
    </div>
    <div v-else-if="!settled" class="tool-card qr-empty tool-hint">输入内容后，二维码会显示在这里</div>

    <div class="tool-card">
      <h3 class="tool-card__title">纠错等级（越高越抗污损，但码更密）</h3>
      <van-radio-group v-model="ecc" direction="horizontal">
        <van-radio v-for="o in ECC_OPTIONS" :key="o.id" :name="o.id">{{ o.label }} {{ o.hint }}</van-radio>
      </van-radio-group>
      <h3 class="tool-card__title qr-gap">边距：{{ border }} 格</h3>
      <van-slider v-model="border" :min="BORDER_MIN" :max="BORDER_MAX" />
      <h3 class="tool-card__title qr-gap">尺寸：{{ size }} px</h3>
      <van-slider v-model="size" :min="SIZE_MIN" :max="SIZE_MAX" :step="32" />
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">前景色</h3>
      <div class="qr-swatches">
        <button
          v-for="c in FG_PRESETS"
          :key="c"
          class="qr-swatch"
          :class="{ 'qr-swatch--on': fg.toLowerCase() === c }"
          :style="{ background: c }"
          :aria-label="'前景 ' + c"
          @click="fg = c"
        />
      </div>
      <van-field v-model="fg" placeholder="#000000" :error-message="parseHex(fg) ? '' : '请输入 #rgb 或 #rrggbb'" />
      <h3 class="tool-card__title qr-gap">背景色</h3>
      <div class="qr-swatches">
        <button
          v-for="c in BG_PRESETS"
          :key="c"
          class="qr-swatch"
          :class="{ 'qr-swatch--on': bg.toLowerCase() === c }"
          :style="{ background: c }"
          :aria-label="'背景 ' + c"
          @click="bg = c"
        />
      </div>
      <van-field v-model="bg" placeholder="#ffffff" :error-message="parseHex(bg) ? '' : '请输入 #rgb 或 #rrggbb'" />
      <p v-if="warning" class="tool-hint qr-warn">{{ warning }}</p>
    </div>

    <div class="tool-actions">
      <van-button type="primary" :disabled="!canDraw" :loading="saving" @click="save">保存 PNG</van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 预览卡片：画布居中 */
.qr-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-2;
}
.qr-canvas {
  width: 100%;
  max-width: 320px;
  height: auto;
  aspect-ratio: 1;
  image-rendering: pixelated;
  border: 1px solid var(--c-border);
}
.qr-empty {
  text-align: center;
}
/* 卡片内分组标题间距 */
.qr-gap {
  margin-top: $space-4;
}
.qr-swatches {
  display: flex;
  gap: $space-3;
  margin-bottom: $space-2;
}
.qr-swatch {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 2px solid var(--c-border);
  border-radius: 50%;

  &--on {
    border-color: var(--c-primary);
  }
}
.qr-warn {
  margin-top: $space-2;
  color: var(--c-error);
}
</style>
