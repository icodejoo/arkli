<script setup lang="ts">
// 二维码生成：输入文本实时画到 Canvas，可调纠错、边距、尺寸、颜色，导出 PNG
import BottomActions from '@/shared/BottomActions.vue'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { canvasToBlob, loadBitmap, EDIT_FULL, pickImages, saveBlob, type PickedImage } from '@/shared/image-io'
import {
  BORDER_MAX,
  BORDER_MIN,
  colorWarning,
  DEFAULT_BG,
  DEFAULT_FG,
  drawQr,
  ECC_OPTIONS,
  fitContain,
  layout,
  LOGO_PCT_DEFAULT,
  LOGO_PCT_MIN,
  logoAdvice,
  logoRects,
  makeQr,
  resolveLogo,
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
/** 纠错等级选项：字母 + 大致恢复能力 */
const ECC_PICK_OPTIONS: CellOption[] = ECC_OPTIONS.map((o) => ({ value: o.id, label: `${o.label} ${o.hint}` }))
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
/** 中间图片位图，未选为 null */
const logo = ref<ImageBitmap | null>(null)
/** 中间图片想要的占比（占码边长，不含静区；实际可能被安全上限压低） */
const logoPct = ref(LOGO_PCT_DEFAULT)
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
/** 中间图片尺寸方案（模块网格对齐，按版本和纠错限制上限）；无图或无结果为 null */
const plan = computed(() => {
  const r = result.value
  return logo.value && r.ok ? resolveLogo(r.value.version, r.value.size, ecc.value, logoPct.value) : null
})
/** 放图片时的提示与升级建议 */
const advice = computed(() => (plan.value ? logoAdvice(ecc.value, settled.value.length, plan.value) : null))
/** 滑块当前值：不超过动态上限（想要的占比保留在 logoPct 里，上限放宽后可恢复） */
const sliderPct = computed({
  get: () => (plan.value ? Math.min(logoPct.value, plan.value.maxPct) : logoPct.value),
  set: (v: number) => (logoPct.value = v),
})
/** 滑块下限：上限太小时跟着降 */
const sliderMin = computed(() => (plan.value ? Math.min(LOGO_PCT_MIN, plan.value.maxPct) : LOGO_PCT_MIN))
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
  drawLogo(ctx, r.value.size)
  pixels.value = side
}
/** 在画布中心按模块网格画底板和图片（底板用背景色整格覆盖，保证周围干净） */
function drawLogo(ctx: CanvasRenderingContext2D, qrSize: number): void {
  const img = logo.value
  const p = plan.value
  if (!img || !p || p.unfit) return
  const { scale } = layout(qrSize, { size: size.value, border: border.value, fg: fg.value, bg: bg.value })
  const { plate, inner } = logoRects(qrSize, border.value, scale, p.modules)
  ctx.fillStyle = bg.value
  ctx.fillRect(plate.x, plate.y, plate.w, plate.h)
  const r = fitContain(img.width, img.height, inner)
  ctx.drawImage(img, r.x, r.y, r.w, r.h)
}

/** 选择中间图片（相册），失败给提示 */
async function pickLogo(): Promise<void> {
  try {
    const got = await pickImages({ edit: EDIT_FULL, multiple: false, max: 1, onFailed: (f) => showFailToast(`读取失败：${f[0].message}`) })
    const one: PickedImage | undefined = got[0]
    if (!one) return
    logo.value?.close()
    logo.value = await loadBitmap(one)
  } catch {
    showFailToast('图片读取失败，请换一张')
  }
}

/** 去掉中间图片 */
function clearLogo(): void {
  logo.value?.close()
  logo.value = null
}
onBeforeUnmount(clearLogo)
watch([result, border, size, fg, bg, logo, logoPct, plan], redraw, { flush: 'post' })

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
    <tool-group title="内容">
      <van-field
        v-model="text"
        type="textarea"
        rows="3"
        autosize
        clearable
        placeholder="输入文字或网址，如 https://example.com"
        :error-message="errorText"
      />
    </tool-group>

    <tool-group v-if="result.ok && colorsValid" class="qr-preview">
      <canvas ref="canvas" class="qr-canvas" />
      <p class="tool-hint">
        版本 {{ result.value.version }} · {{ result.value.size }}×{{ result.value.size }} 模块 · 输出 {{ pixels }}×{{ pixels }} px
      </p>
    </tool-group>
    <tool-group v-else-if="!settled" class="qr-empty tool-hint">输入内容后，二维码会显示在这里</tool-group>

    <tool-group title="纠错与尺寸">
      <cell-picker :model-value="ecc" title="纠错等级" :options="ECC_PICK_OPTIONS" @update:model-value="ecc = $event as EccLevel" />
      <p class="tool-hint">纠错等级越高越抗污损，但码更密。</p>
      <h3 class="tool-group__title qr-gap">边距：{{ border }} 格</h3>
      <van-slider v-model="border" :min="BORDER_MIN" :max="BORDER_MAX" />
      <h3 class="tool-group__title qr-gap">尺寸：{{ size }} px</h3>
      <van-slider v-model="size" :min="SIZE_MIN" :max="SIZE_MAX" :step="32" />
    </tool-group>

    <tool-group title="中间图片（可选）">
      <div class="qr-logo-row">
        <van-button size="small" @click="pickLogo">{{ logo ? '更换图片' : '选择图片' }}</van-button>
        <van-button v-if="logo" size="small" plain @click="clearLogo">去掉</van-button>
      </div>
      <template v-if="logo && plan && advice">
        <h3 class="tool-group__title qr-gap">图片大小：{{ plan.pct }}%（{{ plan.modules }} 格，上限 {{ plan.maxModules }} 格）</h3>
        <van-slider v-model="sliderPct" :min="sliderMin" :max="Math.max(plan.maxPct, 1)" :disabled="plan.unfit" />
        <p v-if="advice.unfitNote" class="tool-hint qr-warn">{{ advice.unfitNote }}</p>
        <p v-if="advice.shrinkNote" class="tool-hint qr-warn">{{ advice.shrinkNote }}</p>
        <p v-if="advice.eccWarning" class="tool-hint qr-warn">{{ advice.eccWarning }}</p>
        <p v-if="advice.longNote" class="tool-hint qr-warn">{{ advice.longNote }}</p>
        <div v-if="advice.upgrade.length" class="qr-logo-row qr-gap-s">
          <van-button v-for="e in advice.upgrade" :key="e" size="small" type="primary" plain @click="ecc = e">纠错升到 {{ e }}</van-button>
        </div>
      </template>
    </tool-group>

    <tool-group title="前景色">
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
      <h3 class="tool-group__title qr-gap">背景色</h3>
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
    </tool-group>

    <!-- 底部动作栏：二维码是实时画出来的，主操作就是保存；中间图片是可选素材，仍在页面里选 -->
    <bottom-actions :main-loading="saving" main main-text="保存 PNG" :disabled="{ main: !canDraw || saving }" @main="save" />
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
.qr-logo-row {
  display: flex;
  gap: $space-3;
}
.qr-gap-s {
  margin-top: $space-2;
}
.qr-warn {
  margin-top: $space-2;
  color: var(--c-error);
}
</style>
