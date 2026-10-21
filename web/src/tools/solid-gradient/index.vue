<script setup lang="ts">
// 纯色图与渐变图：选尺寸，纯色 / 线性渐变（2~5 色标、角度）/ 径向渐变，预览并导出 PNG
import BottomActions from '@/shared/BottomActions.vue'
import ColorPicker from '@/shared/ColorPicker.vue'
import { computed, ref } from 'vue'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { canvasToBlob, createCanvas, releaseCanvas } from '@/shared/image-io'
import {
  addStop,
  checkSize,
  gradientCss,
  linearLine,
  normalizeStops,
  radialCircle,
  removeStop,
  SIZE_PRESETS,
  STOP_MAX,
  STOP_MIN,
  type ColorStop,
  type SizePreset,
} from './logic'

/** 输出文件名前缀 */
const NAME_PREFIX = 'color'
/** 默认纯色 */
const SOLID_DEFAULT = '#4f8cff'
/** 默认渐变角度 */
const ANGLE_DEFAULT = 135
/** 预览框最大宽高比（过高的竖图预览框封顶，避免占满屏） */
const PREVIEW_MAX_RATIO = 1.6

/** 类型：solid 纯色，linear 线性，radial 径向 */
const kind = ref<'solid' | 'linear' | 'radial'>('linear')
/** 纯色值 */
const solid = ref(SOLID_DEFAULT)
/** 色标 */
const stops = ref<ColorStop[]>([
  { color: '#ff7a59', pos: 0 },
  { color: '#4f8cff', pos: 100 },
])
/** 线性渐变角度 */
const angle = ref(ANGLE_DEFAULT)
/** 宽（输入框） */
const width = ref(1080)
/** 高（输入框） */
const height = ref(1920)
/** 结果与批处理状态 */
const { results, busy, saving, process, saveAll } = useImageResults()

/** 预设列表：本机屏幕（有 screen 时）排在最前 */
const presets = computed<SizePreset[]>(() => {
  const ratio = window.devicePixelRatio || 1
  const w = Math.round(screen.width * ratio)
  const h = Math.round(screen.height * ratio)
  const own: SizePreset[] = w > 0 && h > 0 ? [{ label: `${w}×${h} 本机`, width: w, height: h }] : []
  return own.concat(SIZE_PRESETS)
})

/** 尺寸校验 */
const sizeCheck = computed(() => checkSize(Number(width.value), Number(height.value)))

/** 预览用 CSS 背景 */
const previewBg = computed(() => {
  if (kind.value === 'solid') return solid.value
  return gradientCss(kind.value, stops.value, angle.value)
})

/** 预览框高度占宽度的百分比（padding-top 技巧，兼容旧内核） */
const previewPad = computed(() => {
  const { width: w, height: h } = sizeCheck.value
  if (w <= 0 || h <= 0) return 100
  return Math.min(PREVIEW_MAX_RATIO, h / w) * 100
})

/** 套用预设 */
function usePreset(p: SizePreset): void {
  width.value = p.width
  height.value = p.height
}

/** 增加色标 */
function onAdd(): void {
  stops.value = addStop(stops.value)
}

/** 删除色标 */
function onRemove(i: number): void {
  stops.value = removeStop(stops.value, i)
}

/** 色标位置输入后整理排序 */
function onSort(): void {
  stops.value = normalizeStops(stops.value)
}

/** 按当前设置画到画布上 */
function paint(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!
  const w = canvas.width
  const h = canvas.height
  if (kind.value === 'solid') {
    ctx.fillStyle = solid.value
  } else {
    const list = normalizeStops(stops.value)
    let g: CanvasGradient
    if (kind.value === 'linear') {
      const l = linearLine(w, h, angle.value)
      g = ctx.createLinearGradient(l.x0, l.y0, l.x1, l.y1)
    } else {
      const c = radialCircle(w, h)
      g = ctx.createRadialGradient(c.cx, c.cy, 0, c.cx, c.cy, c.r)
    }
    list.forEach((s) => g.addColorStop(s.pos / 100, s.color))
    ctx.fillStyle = g
  }
  ctx.fillRect(0, 0, w, h)
}

/** 导出 PNG */
async function run(): Promise<void> {
  const size = sizeCheck.value
  if (!size.ok) return
  await process([size], async (s) => {
    const canvas = createCanvas(s.width, s.height)
    try {
      paint(canvas)
      const blob = await canvasToBlob(canvas, 'image/png')
      const tag = kind.value === 'solid' ? 'solid' : kind.value
      return { name: `${NAME_PREFIX}_${tag}_${s.width}x${s.height}.png`, blob, width: s.width, height: s.height }
    } finally {
      releaseCanvas(canvas)
    }
  })
}
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="kind" type="card">
      <van-tab title="纯色" name="solid" />
      <van-tab title="线性渐变" name="linear" />
      <van-tab title="径向渐变" name="radial" />
    </van-tabs>

    <tool-group title="预览">
      <div class="sg-box" :style="{ paddingTop: previewPad + '%' }">
        <div class="sg-fill" :style="{ background: previewBg }" />
      </div>
    </tool-group>

    <tool-group title="颜色">
      <van-cell v-if="kind === 'solid'" title="纯色" center>
        <template #value><color-picker v-model="solid" label="纯色" /></template>
      </van-cell>
      <template v-else>
        <div v-for="(s, i) in stops" :key="i" class="sg-stop">
          <color-picker v-model="s.color" :label="`色标 ${i + 1}`" />
          <van-slider v-model="s.pos" class="sg-stop__slider" :min="0" :max="100" @change="onSort" />
          <span class="sg-stop__pos">{{ s.pos }}%</span>
          <van-button size="mini" plain :disabled="stops.length <= STOP_MIN" @click="onRemove(i)">删</van-button>
        </div>
        <van-button size="small" plain :disabled="stops.length >= STOP_MAX" @click="onAdd">加一个色标（最多 {{ STOP_MAX }} 个）</van-button>
        <template v-if="kind === 'linear'">
          <van-cell title="角度" :value="`${angle}°`" />
          <div class="is-slider"><van-slider v-model="angle" :min="0" :max="360" /></div>
        </template>
      </template>
    </tool-group>

    <tool-group title="尺寸">
      <div class="sg-presets">
        <van-button v-for="p in presets" :key="p.label" size="small" plain @click="usePreset(p)">{{ p.label }}</van-button>
      </div>
      <div class="sg-size">
        <van-field v-model.number="width" type="digit" label="宽" input-align="right" />
        <van-field v-model.number="height" type="digit" label="高" input-align="right" />
      </div>
      <p v-if="!sizeCheck.ok" class="tool-hint sg-warn">{{ sizeCheck.message }}</p>
      <p v-else class="tool-hint">输出 {{ sizeCheck.width }}×{{ sizeCheck.height }} PNG</p>
    </tool-group>

    <tool-group v-if="results.length" title="结果（点击预览）">
      <image-result-list :results="results" />
    </tool-group>

    <!-- 底部动作栏：保存结果，主按钮生成图片 -->
    <bottom-actions :main-loading="busy" :actions="{ save: { disabled: !results.length || saving } }" main :main-text="busy ? '生成中' : '生成图片'" :disabled="{ main: busy || !sizeCheck.ok }" @main="run" @save="saveAll" />
  </div>
</template>

<style lang="scss" scoped>
/* 预览框：padding-top 撑出比例，内层绝对定位填满 */
.sg-box {
  position: relative;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--c-border);
  border-radius: 8px;
}

.sg-fill {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
}


.is-slider {
  padding: $space-2 $space-3 $space-3;
}

/* 单个色标一行：色块 + 位置滑杆 + 数值 + 删除 */
.sg-stop {
  display: flex;
  gap: $space-3;
  align-items: center;
  padding: $space-2 0;
}

.sg-stop__slider {
  flex: 1;
}

.sg-stop__pos {
  width: 40px;
  font-size: 12px;
  text-align: right;
  color: var(--c-text-muted);
}

.sg-presets {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  margin-bottom: $space-3;
}

.sg-warn {
  color: var(--c-error);
}
</style>
