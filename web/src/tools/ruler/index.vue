<script setup lang="ts">
// 尺子：App 固定竖屏，尺子竖着贴在屏幕长边（左或右），Canvas 画刻度，靠实物（银行卡/硬币/自定义长度）校准像素与毫米的比例。
// 另有一条可上下拖动的游标，实时预览读数，并可在游标处打下任意多条彩色标记。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { showToast } from 'vant'
import {
  buildTicks,
  CARD_MM,
  clampPos,
  COIN_MM,
  DEFAULT_PX_PER_MM,
  formatLength,
  formatReading,
  formatReadingAlt,
  isValidScale,
  loadScale,
  MARK_COLORS,
  mmToPx,
  pxToMm,
  saveScale,
  scaleFromCalibration,
  STEP_MM,
  STORAGE_PREFIX,
  SCALE_KEY,
  type RulerMark,
  type RulerUnit,
} from './logic'

/** 尺子画布的短边（像素），即尺子的厚度 */
const THICKNESS = 84
/** 游标线和标记线伸出尺子、延伸到页面里的长度（像素），读数标签放在这一段 */
const LINE_EXTENSION = 96
/** 尺子与页面内容之间的留白（像素） */
const GAP = 8
/** 各级刻度线长度（像素） */
const TICK_LEN = { major: 36, half: 24, minor: 14 } as const
/** 校准线最短像素 */
const MIN_CAL_PX = 20
/** 游标的初始位置（像素，离零点） */
const CURSOR_INIT_PX = 120
/** 量不到顶栏时的兜底高度（像素），与 Vant 导航栏默认高度一致 */
const HEADER_FALLBACK = 46
/** 顶栏选择器：尺子要从它的下沿开始，不盖住顶栏 */
const HEADER_SELECTOR = '.van-nav-bar'
/** 校准线两端小竖线的半长（像素） */
const CAL_CAP = 8
/** 刻度数字离刻度线的偏移（像素） */
const LABEL_OFFSET = 12
/** 刻度数字的旋转角（弧度）：靠右顺时针 90°，靠左逆时针 90° */
const LABEL_ROTATE = Math.PI / 2
/** 数字标签离两端的最小距离（像素），避免被裁掉 */
const LABEL_MARGIN = 8
/** 校准线距尺子基线（贴屏幕边缘的那一边）的距离（像素） */
const CAL_LINE_OFFSET = THICKNESS - 18
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

/** 游标位置：离尺子零点的像素距离 */
const cursorPx = ref(CURSOR_INIT_PX)
/** 当前选中的标记颜色 */
const markColor = ref<string>(MARK_COLORS[0].value)
/** 已打下的标记，不限数量 */
const marks = ref<RulerMark[]>([])
/** 标记编号自增序号 */
let markSeq = 0
/** 是否正在拖动游标 */
let dragging = false

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

/** 游标当前离零点的毫米数 */
const cursorMm = computed(() => pxToMm(cursorPx.value, scale.value))
/** 预览区的主读数 */
const previewMain = computed(() => formatReading(cursorMm.value, unit.value))
/** 预览区的辅助读数 */
const previewAlt = computed(() => formatReadingAlt(cursorMm.value, unit.value))
/** 带像素位置与读数文本的标记，位置随校准比例换算，超出尺子的不画 */
const markViews = computed(() =>
  marks.value
    .map((m) => ({ ...m, px: mmToPx(m.mm, scale.value), text: formatReading(m.mm, unit.value) }))
    .filter((m) => m.px >= 0 && m.px <= along.value),
)

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

/** 把游标移到手指所在的位置（clientY 减去尺子顶端即离零点的距离） */
function moveCursorTo(clientY: number): void {
  cursorPx.value = clampPos(clientY - topOffset.value, along.value)
}

/** 手指或鼠标按下：开始拖动，并立即把游标跳到按下的位置 */
function onPointerDown(e: PointerEvent): void {
  dragging = true
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    // 指针号无效（如合成事件）时不捕获，拖动仍按事件坐标工作
  }
  moveCursorTo(e.clientY)
}

/** 拖动中：游标跟手 */
function onPointerMove(e: PointerEvent): void {
  if (dragging) moveCursorTo(e.clientY)
}

/** 抬手或被系统打断：结束拖动 */
function onPointerUp(e: PointerEvent): void {
  dragging = false
  try {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  } catch {
    // 没捕获过就没有可释放的，忽略
  }
}

/**
 * 微调游标，每次一个固定步长，手指拖不准时用。
 *
 * @param dir 方向：-1 往零点方向，1 往远离零点方向
 */
function nudge(dir: -1 | 1): void {
  cursorPx.value = clampPos(cursorPx.value + mmToPx(dir * STEP_MM, scale.value), along.value)
}

/** 在游标当前位置打一条选中颜色的标记，数量不限制 */
function addMark(): void {
  marks.value.push({ id: ++markSeq, mm: cursorMm.value, color: markColor.value })
}

/** 删除一条标记 */
function removeMark(id: number): void {
  marks.value = marks.value.filter((m) => m.id !== id)
}

/** 清空全部标记 */
function clearMarks(): void {
  marks.value = []
}

watch([unit, side, savedScale, calibrating, calPx, refKind, customMm], redraw)
watch(refKind, syncCalPx)
watch(along, (v) => {
  cursorPx.value = clampPos(cursorPx.value, v)
})

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
    <!-- 尺子悬浮在页面之上，贴着屏幕左或右边缘，从顶栏下沿铺到底；只有触摸层接收操作 -->
    <div class="ruler-box" :class="`ruler-box--${side}`" :style="rulerStyle">
      <canvas ref="canvasRef" class="ruler-canvas" aria-hidden="true" />
      <div
        v-for="m in markViews"
        :key="m.id"
        class="ruler-line"
        :style="{ top: `${m.px}px`, background: m.color, '--line-ext': `${LINE_EXTENSION}px` }"
      >
        <span class="ruler-line__tag" :style="{ color: m.color }">{{ m.text }}</span>
      </div>
      <div class="ruler-line ruler-line--cursor" :style="{ top: `${cursorPx}px`, '--line-ext': `${LINE_EXTENSION}px` }">
        <span class="ruler-line__tag ruler-line__tag--cursor">{{ previewMain }}</span>
        <i class="ruler-line__knob" />
      </div>
      <div
        class="ruler-touch"
        role="slider"
        aria-label="游标"
        :aria-valuenow="Math.round(cursorMm * 10) / 10"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
    </div>

    <div v-if="!savedScale" class="tool-hint ruler-warn">未校准，刻度仅供参考。拿银行卡或硬币校准一次就准了。</div>

    <div class="tool-card">
      <h3 class="tool-card__title">游标读数</h3>
      <p class="ruler-preview">{{ previewMain }}</p>
      <p class="tool-hint ruler-preview-alt">{{ previewAlt }}</p>
      <p class="tool-hint">在尺子上按住上下拖动游标；拖不准就用下面两个按钮微调。</p>
      <div class="tool-actions">
        <van-button size="small" @click="nudge(-1)">往上 0.1 mm</van-button>
        <van-button size="small" @click="nudge(1)">往下 0.1 mm</van-button>
      </div>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">标记</h3>
      <div class="ruler-swatches" role="radiogroup" aria-label="标记颜色">
        <button
          v-for="c in MARK_COLORS"
          :key="c.value"
          type="button"
          class="ruler-swatch"
          :class="{ 'ruler-swatch--on': markColor === c.value }"
          :style="{ background: c.value }"
          role="radio"
          :aria-checked="markColor === c.value"
          :aria-label="c.name"
          @click="markColor = c.value"
        />
      </div>
      <div class="tool-actions ruler-gap">
        <van-button type="primary" size="small" @click="addMark">标记</van-button>
        <van-button size="small" :disabled="!marks.length" @click="clearMarks">清除标记</van-button>
      </div>
      <van-cell-group v-if="marks.length" :border="false" class="ruler-gap">
        <van-cell v-for="m in marks" :key="m.id" center>
          <template #title>
            <span class="ruler-dot" :style="{ background: m.color }" />
            <span>{{ formatReading(m.mm, unit) }}</span>
          </template>
          <template #right-icon>
            <van-icon name="cross" class="ruler-del" aria-label="删除这条标记" @click="removeMark(m.id)" />
          </template>
        </van-cell>
      </van-cell-group>
      <p v-else class="tool-hint ruler-gap">点"标记"会在游标当前位置留下一条选中颜色的线，并标出读数，可以连续标记。</p>
    </div>

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
/* 尺子容器：固定在视口边缘，盖过页面；自己不拦截点击，只有触摸层接收操作 */
.ruler-box {
  position: fixed;
  z-index: 100;
  pointer-events: none;
}

/* 画布铺满容器 */
.ruler-canvas {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
}

/* 游标线与标记线：横穿尺子，并向页面一侧伸出一段放读数 */
.ruler-line {
  position: absolute;
  height: 2px;
  margin-top: -1px;
  pointer-events: none;

  &--cursor {
    background: var(--c-text);
  }

  &__tag {
    position: absolute;
    bottom: 4px;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--c-surface);
    font-size: 12px;
    font-weight: 600;
    line-height: 18px;
    white-space: nowrap;

    &--cursor {
      color: var(--c-text);
    }
  }

  /* 拖动把手：一个小圆点，提示这里可以抓 */
  &__knob {
    position: absolute;
    top: -5px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--c-text);
  }
}

/* 靠右：线向左伸出，标签与把手在伸出段的左端 */
.ruler-box--right .ruler-line {
  right: 0;
  left: calc(var(--line-ext) * -1);

  &__tag {
    left: 4px;
  }

  &__knob {
    left: -6px;
  }
}

/* 靠左：线向右伸出，标签与把手在伸出段的右端 */
.ruler-box--left .ruler-line {
  left: 0;
  right: calc(var(--line-ext) * -1);

  &__tag {
    right: 4px;
  }

  &__knob {
    right: -6px;
  }
}

/* 触摸层：只盖住尺子本身，禁掉浏览器的手势，才能顺畅地上下拖 */
.ruler-touch {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: auto;
  touch-action: none;
}

/* 预览区的大数字 */
.ruler-preview {
  margin: 0;
  font-size: 40px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--c-text);
  font-variant-numeric: tabular-nums;
}

.ruler-preview-alt {
  margin: $space-1 0 $space-2;
}

/* 标记颜色选项 */
.ruler-swatches {
  display: flex;
  gap: $space-3;
}

.ruler-swatch {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--c-surface) inset;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;

  &--on {
    border-color: var(--c-text);
  }
}

/* 标记列表里的色点 */
.ruler-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: $space-2;
  border-radius: 50%;
}

.ruler-del {
  padding: $space-1;
  color: var(--c-text-muted);
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
