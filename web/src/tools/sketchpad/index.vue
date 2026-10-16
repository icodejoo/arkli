<script setup lang="ts">
// 画板：Pointer Events 画笔，笔画存成栈，撤销/重做靠重绘；导出 PNG 走 saveBlob
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { canvasToBlob, createCanvas, releaseCanvas, saveBlob } from '@/shared/image-io'
import {
  addStroke, appendPoint, canRedo, canUndo, canvasScale, clampWidth, clearStack, createStack, DEFAULT_BG,
  DEFAULT_COLOR, exportName, MAX_WIDTH, MIN_WIDTH, pixelSize, redo, undo, type Pt, type Stroke, type StrokeStack,
} from './logic'

/** 画布高度占宽度的比例 */
const HEIGHT_RATIO = 1.25
/** 画布高度上限（CSS 像素），避免手机上比屏幕还高 */
const MAX_CSS_HEIGHT = 560
/** 画笔预设色 */
const PALETTE = ['#222222', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#ffffff']
/** 背景预设色 */
const BG_PALETTE = ['#ffffff', '#fff8e1', '#e8f5e9', '#e3f2fd', '#212121']
/** 橡皮相对画笔的放大倍数 */
const ERASER_SCALE = 2.5
/** 默认线宽 */
const DEFAULT_WIDTH = 6

/** 画布元素 */
const canvasEl = ref<HTMLCanvasElement>()
/** 画布外层容器，用来量宽度 */
const wrapEl = ref<HTMLDivElement>()
/** 笔画栈 */
const stack = shallowRef<StrokeStack>(createStack())
/** 当前正在画的笔画 */
const current = shallowRef<Stroke | null>(null)
/** 画笔颜色 */
const color = ref(DEFAULT_COLOR)
/** 背景色 */
const bg = ref(DEFAULT_BG)
/** 线宽 */
const width = ref(DEFAULT_WIDTH)
/** 是否橡皮模式 */
const erasing = ref(false)
/** 画布 CSS 宽 */
let cssW = 0
/** 画布 CSS 高 */
let cssH = 0
/** 正在绘制的指针 id，用来忽略多指 */
let activeId = -1
/** 待执行的重绘帧句柄 */
let raf = 0
/** 容器尺寸监听器 */
let observer: ResizeObserver | undefined
/** 导出中 */
const saving = ref(false)

/** 能否撤销 */
const undoable = computed(() => canUndo(stack.value) || current.value !== null)
/** 能否重做 */
const redoable = computed(() => canRedo(stack.value))

/**
 * 把一条笔画画到上下文（坐标为 CSS 像素，ctx 已按 scale 缩放）。
 *
 * @param ctx 目标上下文
 * @param s 笔画
 */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  const pts = s.points
  if (!pts.length) return
  ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (pts.length === 1) {
    ctx.beginPath()
    ctx.arc(pts[0].x, pts[0].y, s.width / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  // 用相邻点中点做二次曲线，线条更顺滑
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last.x, last.y)
  ctx.stroke()
}

/**
 * 把背景和全部笔画渲染到目标画布。笔画先画在透明图层上，橡皮才能只擦笔迹不擦背景。
 *
 * @param target 目标画布
 * @param scale 像素缩放
 * @param extra 额外要画的进行中笔画
 */
function render(target: HTMLCanvasElement, scale: number, extra: Stroke | null): void {
  const ctx = target.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = bg.value
  ctx.fillRect(0, 0, target.width, target.height)
  const layer = createCanvas(target.width, target.height)
  const lctx = layer.getContext('2d')
  if (lctx) {
    lctx.scale(scale, scale)
    for (const s of stack.value.strokes) drawStroke(lctx, s)
    if (extra) drawStroke(lctx, extra)
    ctx.drawImage(layer, 0, 0)
  }
  releaseCanvas(layer)
}

/** 当前屏幕缩放系数 */
function screenScale(): number {
  return canvasScale(cssW, cssH, window.devicePixelRatio || 1)
}

/** 重绘屏幕画布 */
function redraw(): void {
  const c = canvasEl.value
  if (c) render(c, screenScale(), current.value)
}

/** 合并同一帧内的多次重绘请求 */
function scheduleRedraw(): void {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    redraw()
  })
}

/** 按容器宽度调整画布尺寸并重绘 */
function resize(): void {
  const c = canvasEl.value
  const wrap = wrapEl.value
  if (!c || !wrap) return
  const w = Math.floor(wrap.clientWidth)
  if (w <= 0) return
  const h = Math.min(MAX_CSS_HEIGHT, Math.round(w * HEIGHT_RATIO))
  if (w === cssW && h === cssH) return
  cssW = w
  cssH = h
  const px = pixelSize(w, h, screenScale())
  c.width = px.width
  c.height = px.height
  c.style.width = `${w}px`
  c.style.height = `${h}px`
  redraw()
}

/**
 * 把指针事件换成画布 CSS 坐标。
 *
 * @param e 指针事件
 * @returns 坐标
 */
function toPoint(e: PointerEvent): Pt {
  const r = canvasEl.value!.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

/** 落笔：开始一条新笔画 */
function onDown(e: PointerEvent): void {
  if (activeId !== -1 || (e.pointerType === 'mouse' && e.button !== 0)) return
  activeId = e.pointerId
  canvasEl.value?.setPointerCapture(e.pointerId)
  const w = erasing.value ? clampWidth(width.value * ERASER_SCALE) : width.value
  current.value = { points: [toPoint(e)], color: color.value, width: w, erase: erasing.value }
  scheduleRedraw()
}

/** 移动：给当前笔画追加点（合并的高频点也一并取） */
function onMove(e: PointerEvent): void {
  const s = current.value
  if (!s || e.pointerId !== activeId) return
  const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
  for (const ev of evs.length ? evs : [e]) appendPoint(s.points, toPoint(ev))
  scheduleRedraw()
}

/** 抬笔或被打断：把当前笔画入栈 */
function onUp(e: PointerEvent): void {
  const s = current.value
  if (!s || e.pointerId !== activeId) return
  activeId = -1
  current.value = null
  stack.value = addStroke(stack.value, s)
  scheduleRedraw()
}

/** 撤销；正在画时先放弃当前笔画 */
function doUndo(): void {
  if (current.value) {
    current.value = null
    activeId = -1
  } else {
    stack.value = undo(stack.value)
  }
  redraw()
}

/** 重做 */
function doRedo(): void {
  stack.value = redo(stack.value)
  redraw()
}

/** 清空画布 */
function doClear(): void {
  stack.value = clearStack()
  current.value = null
  activeId = -1
  redraw()
}

/** 换背景色并重绘 */
function setBg(c: string): void {
  bg.value = c
  redraw()
}

/** 选画笔颜色，同时退出橡皮 */
function pickColor(c: string): void {
  color.value = c
  erasing.value = false
}

/** 线宽滑块的取值转换 */
function onWidth(v: number): void {
  width.value = clampWidth(v)
}

/** 导出 PNG：按封顶后的缩放重新渲染一张，再保存 */
async function exportPng(): Promise<void> {
  if (saving.value || !cssW) return
  saving.value = true
  const px = pixelSize(cssW, cssH, screenScale())
  const out = createCanvas(px.width, px.height)
  try {
    render(out, screenScale(), null)
    const blob = await canvasToBlob(out, 'image/png')
    const res = await saveBlob(blob, exportName(new Date()))
    showSuccessToast(res.mode === 'native' ? '已保存到相册' : '已开始下载')
  } catch {
    showFailToast('保存失败')
  } finally {
    releaseCanvas(out)
    saving.value = false
  }
}

onMounted(() => {
  resize()
  if (typeof ResizeObserver !== 'undefined' && wrapEl.value) {
    observer = new ResizeObserver(resize)
    observer.observe(wrapEl.value)
  } else {
    window.addEventListener('resize', resize)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', resize)
  if (raf) cancelAnimationFrame(raf)
})
</script>

<template>
  <div class="tool-page">
    <div ref="wrapEl" class="sk-wrap">
      <canvas
        ref="canvasEl"
        class="sk-canvas"
        @pointerdown.prevent="onDown"
        @pointermove.prevent="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      />
    </div>

    <tool-group>
      <div class="tool-actions">
        <van-button size="small" :disabled="!undoable" @click="doUndo">撤销</van-button>
        <van-button size="small" :disabled="!redoable" @click="doRedo">重做</van-button>
        <van-button size="small" :type="erasing ? 'primary' : 'default'" @click="erasing = !erasing">橡皮</van-button>
        <van-button size="small" @click="doClear">清空</van-button>
      </div>
      <h3 class="tool-group__title sk-title">画笔颜色</h3>
      <div class="sk-swatches">
        <button
          v-for="c in PALETTE"
          :key="c"
          type="button"
          class="sk-swatch"
          :class="{ 'sk-swatch--on': !erasing && color === c }"
          :style="{ background: c }"
          :aria-label="`画笔颜色 ${c}`"
          @click="pickColor(c)"
        />
      </div>
      <h3 class="tool-group__title sk-title">粗细 {{ width }}</h3>
      <van-slider :model-value="width" :min="MIN_WIDTH" :max="MAX_WIDTH" @update:model-value="onWidth" />
      <h3 class="tool-group__title sk-title">背景色</h3>
      <div class="sk-swatches">
        <button
          v-for="c in BG_PALETTE"
          :key="c"
          type="button"
          class="sk-swatch"
          :class="{ 'sk-swatch--on': bg === c }"
          :style="{ background: c }"
          :aria-label="`背景色 ${c}`"
          @click="setBg(c)"
        />
      </div>
    </tool-group>

    <p class="tool-hint">清空不能撤销。画板内容不会自动保存，离开页面就没了。</p>

    <!-- 底部动作栏：画板没有「生成」一步，主操作就是保存为图片 -->
    <bottom-actions main main-text="保存为图片" :disabled="{ main: saving }" @main="exportPng" />
  </div>
</template>

<style lang="scss" scoped>
/* 画布外框 */
.sk-wrap {
  width: 100%;
  overflow: hidden;
  border-radius: var(--tool-card-radius);
  background: var(--c-surface);
  line-height: 0;
}

/* 画布：禁掉浏览器手势，否则触摸会被当成滚动 */
.sk-canvas {
  display: block;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

/* 卡片内小标题与上方留距 */
.sk-title {
  margin-top: $space-3;
}

/* 色块排布 */
.sk-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: $space-3;
}

/* 单个色块 */
.sk-swatch {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--c-text-muted);
  border-radius: 50%;
  cursor: pointer;

  &--on {
    outline: 2px solid var(--c-primary);
    outline-offset: 2px;
  }
}
</style>
