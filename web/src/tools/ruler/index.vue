<script setup lang="ts">
// 尺子：Canvas 画刻度，靠实物（银行卡/硬币/自定义长度）校准像素与毫米的比例
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { showToast } from 'vant'
import {
  buildTicks,
  CARD_MM,
  COIN_MM,
  DEFAULT_PX_PER_MM,
  formatLength,
  isValidScale,
  loadScale,
  saveScale,
  scaleFromCalibration,
  STORAGE_PREFIX,
  SCALE_KEY,
  type RulerUnit,
} from './logic'

/** 尺子画布的短边（像素） */
const THICKNESS = 84
/** 竖向尺子的最小长度（像素） */
const MIN_VERTICAL = 240
/** 竖向尺子的最大长度（像素） */
const MAX_VERTICAL = 900
/** 竖向尺子要给页面其它内容让出的高度（像素） */
const VERTICAL_RESERVE = 200
/** 各级刻度线长度（像素） */
const TICK_LEN = { major: 36, half: 24, minor: 14 } as const
/** 校准线最短像素 */
const MIN_CAL_PX = 20
/** 参照物类型 */
type RefKind = 'card' | 'coin' | 'custom'

/** 取本地存储，不可用时为 undefined */
function getStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/** 当前单位 */
const unit = ref<RulerUnit>('cm')
/** 是否竖向摆放 */
const vertical = ref(false)
/** 已保存的校准比例（像素/毫米），null 表示未校准 */
const savedScale = ref<number | null>(loadScale(getStorage()))
/** 生效的比例：校准过用校准值，否则用 96dpi 估算 */
const scale = computed(() => savedScale.value ?? DEFAULT_PX_PER_MM)
/** 是否处于校准模式 */
const calibrating = ref(false)
/** 参照物类型 */
const refKind = ref<RefKind>('card')
/** 自定义参照长度文本（毫米） */
const customMm = ref('50')
/** 校准线像素长度（用户调整） */
const calPx = ref(200)
/** 画布容器 */
const wrapRef = ref<HTMLDivElement>()
/** 画布 */
const canvasRef = ref<HTMLCanvasElement>()
/** 容器宽度（像素） */
const wrapWidth = ref(320)
/** 竖向尺子长度（像素） */
const verticalLen = ref(MIN_VERTICAL)

/** 参照物实际长度（毫米），自定义不合法时为 0 */
const refMm = computed(() => (refKind.value === 'card' ? CARD_MM : refKind.value === 'coin' ? COIN_MM : Number(customMm.value) || 0))
/** 尺子沿长边的像素长度 */
const along = computed(() => (vertical.value ? verticalLen.value : wrapWidth.value))
/** 校准线是否能放进当前尺子（按当前比例估算） */
const calFits = computed(() => refMm.value > 0 && refMm.value * scale.value <= along.value)
/** 校准线按当前像素换算出的比例 */
const calScale = computed(() => scaleFromCalibration(calPx.value, refMm.value))
/** 校准线长度的上限 */
const calMax = computed(() => Math.max(MIN_CAL_PX + 1, Math.floor(along.value)))
/** 校准线当前长度的展示文本 */
const calText = computed(() => `${calPx.value.toFixed(1)} px 对应 ${refMm.value} mm`)
/** 比例是否合法（模板判断用） */
const scaleOk = computed(() => isValidScale(scale.value))
/** 整把尺子的实际长度文本 */
const totalText = computed(() => formatLength(along.value, scale.value, unit.value))

/** 读 CSS 变量，读不到用兜底色 */
function cssColor(name: string, fallback: string): string {
  const el = canvasRef.value
  const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : ''
  return v || fallback
}

/** 重新量一遍容器尺寸 */
function measure(): void {
  wrapWidth.value = Math.floor(wrapRef.value?.clientWidth || 320)
  verticalLen.value = Math.max(MIN_VERTICAL, Math.min(MAX_VERTICAL, window.innerHeight - VERTICAL_RESERVE))
}

/** 画一条线：(a,b) 是（沿尺方向，垂直尺方向）坐标，竖向时自动对调 */
function line(ctx: CanvasRenderingContext2D, a: number, b: number, a2: number, b2: number): void {
  ctx.beginPath()
  if (vertical.value) {
    ctx.moveTo(b, a)
    ctx.lineTo(b2, a2)
  } else {
    ctx.moveTo(a, b)
    ctx.lineTo(a2, b2)
  }
  ctx.stroke()
}

/** 重画整把尺子 */
function draw(): void {
  const cv = canvasRef.value
  if (!cv) return
  const w = vertical.value ? THICKNESS : along.value
  const h = vertical.value ? along.value : THICKNESS
  const dpr = window.devicePixelRatio || 1
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  cv.style.width = `${w}px`
  cv.style.height = `${h}px`
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const text = cssColor('--c-text', '#1b1d22')
  const primary = cssColor('--c-primary', '#3b6cf6')
  ctx.strokeStyle = text
  ctx.fillStyle = text
  ctx.lineWidth = 1
  ctx.font = '12px sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  for (const t of buildTicks(along.value, scale.value, unit.value)) {
    const p = Math.round(t.pos) + 0.5
    line(ctx, p, 0, p, TICK_LEN[t.kind])
    if (t.label != null) {
      const lp = Math.max(8, Math.min(along.value - 8, t.pos))
      if (vertical.value) ctx.fillText(t.label, TICK_LEN.major + 12, lp)
      else ctx.fillText(t.label, lp, TICK_LEN.major + 12)
    }
  }
  if (calibrating.value) {
    const y = THICKNESS - 18
    ctx.strokeStyle = primary
    ctx.lineWidth = 2
    line(ctx, 0, y, calPx.value, y)
    line(ctx, 0, y - 8, 0, y + 8)
    line(ctx, calPx.value, y - 8, calPx.value, y + 8)
  }
}

/** 单位或方向切换后重排重画 */
async function redraw(): Promise<void> {
  await nextTick()
  measure()
  draw()
}

/** 按当前比例下参照物的长度重置校准线（长度限制在尺子范围内） */
function syncCalPx(): void {
  const px = refMm.value * scale.value
  calPx.value = Math.max(MIN_CAL_PX, Math.min(calMax.value, Math.round(px * 2) / 2))
}

/** 进入校准模式 */
function startCalibrate(): void {
  calibrating.value = true
  syncCalPx()
}

/** 保存校准结果 */
function saveCalibrate(): void {
  const s = calScale.value
  if (s == null) {
    showToast('参照长度或线长不合理，没法校准')
    return
  }
  savedScale.value = s
  showToast(saveScale(getStorage(), s) ? '校准已保存' : '已生效，但存储不可用，下次要重新校准')
  calibrating.value = false
}

/** 清除校准，回到估算值 */
function resetCalibrate(): void {
  savedScale.value = null
  try {
    getStorage()?.removeItem(STORAGE_PREFIX + SCALE_KEY)
  } catch {
    // 存储不可用时忽略，内存里已重置
  }
  calibrating.value = false
  showToast('已清除校准')
}

watch([unit, vertical, savedScale, calibrating, calPx, refKind, customMm], redraw)
watch(refKind, syncCalPx)
watch(vertical, async () => {
  if (!calibrating.value) return
  await redraw()
  syncCalPx()
})

/** 窗口尺寸变化（含横竖屏切换）与深浅色切换时重画 */
function onResize(): void {
  void redraw()
}

/** 深色模式媒体查询，用于卸载时解绑 */
let mql: MediaQueryList | undefined
onMounted(() => {
  void redraw()
  window.addEventListener('resize', onResize)
  mql = window.matchMedia?.('(prefers-color-scheme: dark)')
  mql?.addEventListener?.('change', onResize)
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  mql?.removeEventListener?.('change', onResize)
})
</script>

<template>
  <div class="tool-page">
    <div v-if="!savedScale" class="tool-hint ruler-warn">未校准，刻度仅供参考。拿银行卡或硬币校准一次就准了。</div>

    <div class="tool-card">
      <div ref="wrapRef" class="ruler-wrap" :class="{ 'ruler-wrap--v': vertical }">
        <canvas ref="canvasRef" class="ruler-canvas" />
      </div>
      <p v-if="scaleOk" class="tool-hint ruler-total">尺长约 {{ totalText }}</p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">单位与方向</h3>
      <van-radio-group v-model="unit" direction="horizontal">
        <van-radio name="cm">厘米</van-radio>
        <van-radio name="inch">英寸</van-radio>
      </van-radio-group>
      <van-cell-group :border="false" class="ruler-gap">
        <van-cell title="竖向摆放" center>
          <template #value><van-switch v-model="vertical" size="22" /></template>
        </van-cell>
      </van-cell-group>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">校准</h3>
      <template v-if="!calibrating">
        <p class="tool-hint">不同手机的真实像素密度不一样，用实物对一下刻度才准。</p>
        <div class="tool-actions">
          <van-button type="primary" size="small" @click="startCalibrate">开始校准</van-button>
          <van-button v-if="savedScale" size="small" @click="resetCalibrate">清除校准</van-button>
        </div>
      </template>
      <template v-else>
        <van-radio-group v-model="refKind" direction="horizontal">
          <van-radio name="card">银行卡 85.6mm</van-radio>
          <van-radio name="coin">一元硬币 25mm</van-radio>
          <van-radio name="custom">自定义</van-radio>
        </van-radio-group>
        <van-field v-if="refKind === 'custom'" v-model="customMm" type="number" label="已知长度" placeholder="毫米" />
        <p class="tool-hint">把实物沿尺子上的蓝线放好，调整蓝线长度，直到与实物两端对齐。银行卡较长，横向放不下时请打开「竖向摆放」。</p>
        <p v-if="!calFits" class="tool-hint ruler-warn">当前尺子放不下这个参照物，换小一点的参照物或切换方向。</p>
        <van-slider v-model="calPx" :min="MIN_CAL_PX" :max="calMax" :step="0.5" class="ruler-slider" />
        <van-stepper v-model="calPx" input-width="64px" :min="MIN_CAL_PX" :max="calMax" :step="0.5" :decimal-length="1" />
        <p class="tool-hint">{{ calText }}</p>
        <div class="tool-actions">
          <van-button type="primary" size="small" @click="saveCalibrate">保存校准</van-button>
          <van-button size="small" @click="calibrating = false">取消</van-button>
        </div>
      </template>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 画布容器：竖向时收窄到画布宽度 */
.ruler-wrap {
  width: 100%;
  overflow: hidden;

  &--v {
    width: 84px;
  }
}

/* 画布本体 */
.ruler-canvas {
  display: block;
}

/* 未校准提示：警示色底 */
.ruler-warn {
  padding: $space-2 $space-3;
  border-radius: 10px;
  background: var(--c-warn-bg);
  color: var(--c-warn-text);
}

/* 总长提示 */
.ruler-total {
  margin: $space-2 0 0;
}

/* 单元间距 */
.ruler-gap {
  margin-top: $space-2;
}

/* 滑杆与前后元素留距 */
.ruler-slider {
  margin: $space-4 $space-2;
}
</style>
