<script setup lang="ts">
// 尺子：App 固定竖屏，尺子竖着贴在屏幕长边（左或右），Canvas 画刻度，靠实物（银行卡/硬币/自定义长度）校准像素与毫米的比例
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

/** 尺子画布的短边（像素），即尺子的厚度 */
const THICKNESS = 84
/** 尺子与页面内容之间的留白（像素） */
const GAP = 8
/** 各级刻度线长度（像素） */
const TICK_LEN = { major: 36, half: 24, minor: 14 } as const
/** 校准线最短像素 */
const MIN_CAL_PX = 20
/** 刻度数字离刻度线的偏移（像素） */
const LABEL_OFFSET = 12
/** 刻度数字的旋转角（弧度）：靠右顺时针 90°，靠左逆时针 90° */
const LABEL_ROTATE = Math.PI / 2
/** 数字标签离两端的最小距离（像素），避免被裁掉 */
const LABEL_MARGIN = 8
/** 校准线距尺子基线（贴屏幕边缘的那一边）的距离（像素） */
const CAL_LINE_OFFSET = THICKNESS - 18
/** 量不到顶栏时的兜底高度（像素），与 Vant 导航栏默认高度一致 */
const HEADER_FALLBACK = 46
/** 顶栏选择器：尺子要从它的下沿开始，不盖住顶栏 */
const HEADER_SELECTOR = '.van-nav-bar'
/** 校准线两端小竖线的半长（像素） */
const CAL_CAP = 8
/** 尺面底色的不透明度 */
const SURFACE_ALPHA = 0.92
/** 参照物类型 */
type RefKind = 'card' | 'coin' | 'custom'
/** 尺子靠屏幕哪一侧 */
type EdgeSide = 'right' | 'left'

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
/** 尺子靠右还是靠左 */
const side = ref<EdgeSide>('right')
/** 尺子顶端离视口顶部的距离（像素），即顶栏下沿 */
const topOffset = ref(HEADER_FALLBACK)
/** 尺子沿长边的像素长度：视口高度减去顶栏 */
const along = ref(640)
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
/** 画布 */
const canvasRef = ref<HTMLCanvasElement>()

/** 参照物实际长度（毫米），自定义不合法时为 0 */
const refMm = computed(() => (refKind.value === 'card' ? CARD_MM : refKind.value === 'coin' ? COIN_MM : Number(customMm.value) || 0))
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
/** 使用说明里描述尺子所在位置的文本 */
const placeText = computed(() => `在${side.value === 'right' ? '右' : '左'}侧边缘，从顶栏下沿往下数`)
/** 尺子的悬浮定位：贴左或右边缘，从顶栏下沿铺到屏幕底边 */
const rulerStyle = computed(() => ({
  top: `${topOffset.value}px`,
  [side.value]: '0',
  width: `${THICKNESS}px`,
  height: `${along.value}px`,
}))
/** 页面内容给尺子让位：让出靠边那一侧 */
const pageStyle = computed(() => {
  const pad = `${THICKNESS + GAP}px`
  return side.value === 'right' ? { paddingRight: pad } : { paddingLeft: pad }
})

/** 读 CSS 变量，读不到用兜底色 */
function cssColor(name: string, fallback: string): string {
  const el = canvasRef.value
  const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : ''
  return v || fallback
}

/** 重新量一遍：顶栏下沿的位置，以及从那里到屏幕底边的长度 */
function measure(): void {
  const header = document.querySelector(HEADER_SELECTOR)
  // 用 offset 而不是 getBoundingClientRect：路由切换动画有 transform 位移，后者会量到动画中途的位置
  const bottom = header instanceof HTMLElement ? header.offsetTop + header.offsetHeight : HEADER_FALLBACK
  topOffset.value = bottom > 0 ? bottom : HEADER_FALLBACK
  along.value = Math.max(MIN_CAL_PX, Math.floor(window.innerHeight - topOffset.value))
}

/**
 * 把（沿尺方向 a，离基线距离 b）换算成画布坐标。
 * 基线就是贴着屏幕边缘的那一边：靠右时在画布右侧，靠左时在左侧。
 *
 * @param a 沿尺方向的位置（像素，从尺子零点起）
 * @param b 垂直尺方向、离基线的距离（像素）
 * @returns 画布上的 [x, y]
 */
function toXY(a: number, b: number): [number, number] {
  return side.value === 'right' ? [THICKNESS - b, a] : [b, a]
}

/** 画一条线，端点用（沿尺方向，离基线距离）表示 */
function line(ctx: CanvasRenderingContext2D, a: number, b: number, a2: number, b2: number): void {
  const [x1, y1] = toXY(a, b)
  const [x2, y2] = toXY(a2, b2)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

/** 重画整把尺子 */
function draw(): void {
  const cv = canvasRef.value
  if (!cv) return
  const w = THICKNESS
  const h = along.value
  const dpr = window.devicePixelRatio || 1
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  cv.style.width = `${w}px`
  cv.style.height = `${h}px`
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  // 尺面底色：让刻度在任何页面背景上都看得清，同时标出"尺子在这里"
  ctx.fillStyle = cssColor('--c-surface', '#ffffff')
  ctx.globalAlpha = SURFACE_ALPHA
  ctx.fillRect(0, 0, w, h)
  ctx.globalAlpha = 1
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
      const lp = Math.max(LABEL_MARGIN, Math.min(along.value - LABEL_MARGIN, t.pos))
      const [x, y] = toXY(lp, TICK_LEN.major + LABEL_OFFSET)
      // 数字顺着尺子的方向书写：字头朝向屏幕边缘（刻度线一侧）
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(side.value === 'right' ? LABEL_ROTATE : -LABEL_ROTATE)
      ctx.fillText(t.label, 0, 0)
      ctx.restore()
    }
  }
  if (calibrating.value) {
    ctx.strokeStyle = primary
    ctx.lineWidth = 2
    line(ctx, 0, CAL_LINE_OFFSET, calPx.value, CAL_LINE_OFFSET)
    line(ctx, 0, CAL_LINE_OFFSET - CAL_CAP, 0, CAL_LINE_OFFSET + CAL_CAP)
    line(ctx, calPx.value, CAL_LINE_OFFSET - CAL_CAP, calPx.value, CAL_LINE_OFFSET + CAL_CAP)
  }
}

/** 单位、靠边或校准状态变化后重量重画 */
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

watch([unit, side, savedScale, calibrating, calPx, refKind, customMm], redraw)
watch(refKind, syncCalPx)

/** 窗口尺寸变化与深浅色切换时重画 */
function onResize(): void {
  void redraw()
}

/** 深色模式媒体查询，用于卸载时解绑 */
let mql: MediaQueryList | undefined
onMounted(() => {
  void redraw()
  // 挂载当帧顶栏可能还没排好版，下一帧再量一次，避免尺子顶端与顶栏下沿差几像素
  requestAnimationFrame(() => void redraw())
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
  <div class="tool-page" :style="pageStyle">
    <!-- 尺子悬浮在页面之上，贴着屏幕左或右边缘，从顶栏下沿铺到底；不拦截点击 -->
    <canvas ref="canvasRef" class="ruler-canvas" :style="rulerStyle" aria-hidden="true" />

    <div v-if="!savedScale" class="tool-hint ruler-warn">未校准，刻度仅供参考。拿银行卡或硬币校准一次就准了。</div>

    <div class="tool-card">
      <h3 class="tool-card__title">怎么用</h3>
      <p class="tool-hint">
        尺子贴着屏幕的长边，{{ placeText }}。把要量的东西贴着屏幕边放就行。零点在顶栏下沿，不在手机屏幕最顶端。
      </p>
      <p v-if="scaleOk" class="tool-hint ruler-total">尺长约 {{ totalText }}</p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">单位与位置</h3>
      <van-radio-group v-model="unit" direction="horizontal">
        <van-radio name="cm">厘米</van-radio>
        <van-radio name="inch">英寸</van-radio>
      </van-radio-group>
      <van-radio-group v-model="side" direction="horizontal" class="ruler-gap">
        <van-radio name="right">靠右</van-radio>
        <van-radio name="left">靠左</van-radio>
      </van-radio-group>
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
        <p class="tool-hint">把实物沿屏幕边缘的蓝线放好（蓝线从零点起），调整蓝线长度，直到与实物两端对齐。</p>
        <p v-if="!calFits" class="tool-hint ruler-warn">当前尺子放不下这个参照物，换小一点的参照物。</p>
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
/* 尺子画布：固定在视口长边，盖过顶栏；不拦截点击，下面的控件照常可点 */
.ruler-canvas {
  position: fixed;
  z-index: 100;
  display: block;
  pointer-events: none;
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
  margin-top: $space-3;
}

/* 滑杆与前后元素留距 */
.ruler-slider {
  margin: $space-4 $space-2;
}
</style>
