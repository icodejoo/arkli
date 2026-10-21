<script setup lang="ts">
// 浮窗圆球：显示被浮起工具的图标，可拖动并吸边；点击回到工具；拖进底部“取消浮窗”投放区松手则关闭浮窗
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useFloatStore } from '@/stores/float'
import { toolIcon } from '@/views/toolIcons'
import {
  BALL_SIZE,
  DEFAULT_Y_RATIO,
  DROP_BOTTOM,
  DROP_SIZE,
  FLOAT_POS_KEY,
  FLOAT_Z,
  clampX,
  clampY,
  exceedsDrag,
  floatBallLabel,
  inDropZone,
  parsePos,
  sideX,
  snapSide,
  type FloatPos,
} from './floatBall'

/** 投放区文案 */
const DROP_LABEL = '取消浮窗'

const float = useFloatStore()
const route = useRoute()
const router = useRouter()

/** 读存储的停靠位置；没有或存储不可用返回 null（默认位置在渲染时按当时屏高算，因为模块初始化时 innerHeight 可能还是 0） */
function loadPos(): FloatPos | null {
  try {
    const p = parsePos(localStorage.getItem(FLOAT_POS_KEY))
    if (p) return p
  } catch {
    // 存储不可用走默认
  }
  return null
}
/** 保存停靠位置（失败静默） */
function savePos(p: FloatPos): void {
  try {
    localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(p))
  } catch {
    // 只在内存里
  }
}

/** 停靠位置 */
const pos = ref<FloatPos | null>(loadPos())
/** 拖动中的实时坐标，不拖动时为 null */
const dragXY = ref<{ x: number; y: number } | null>(null)
/** 拖动中圆球是否在投放区内 */
const overDrop = ref(false)
/** 按下起点与圆球起点 */
let start: { px: number; py: number; bx: number; by: number } | null = null
/** 这次按下是否已算拖动 */
let moved = false

/** 当前路由正是被浮起的工具页时隐藏（它已在前台，随后会被取回） */
const visible = computed(() => !!float.floating && !(route.name === 'tool' && route.params.id === float.floating.id))
/** 工具图标 */
const icon = computed(() => (float.floating ? toolIcon(float.floating.id) : ''))
/** 无障碍标签 */
const label = computed(() => floatBallLabel(float.floating?.name ?? ''))
/** 圆球的定位样式：拖动用实时坐标，否则按停靠边 */
const ballStyle = computed(() => {
  const side = pos.value?.side ?? 'right'
  const x = dragXY.value ? dragXY.value.x : sideX(side, window.innerWidth)
  const y = dragXY.value ? dragXY.value.y : clampY(pos.value?.y ?? window.innerHeight * DEFAULT_Y_RATIO, window.innerHeight)
  return { transform: `translate3d(${x}px, ${y}px, 0)`, zIndex: FLOAT_Z, width: `${BALL_SIZE}px`, height: `${BALL_SIZE}px` }
})

/** 按下：记起点并捕获指针 */
function onDown(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  start = { px: e.clientX, py: e.clientY, bx: rect.left, by: rect.top }
  moved = false
  el.setPointerCapture?.(e.pointerId)
}
/** 移动：超过阈值后进入拖动，实时更新位置与投放命中 */
function onMove(e: PointerEvent): void {
  if (!start) return
  const dx = e.clientX - start.px
  const dy = e.clientY - start.py
  if (!moved && !exceedsDrag(dx, dy)) return
  moved = true
  const vw = window.innerWidth
  const vh = window.innerHeight
  const x = clampX(start.bx + dx, vw)
  const y = Math.min(Math.max(start.by + dy, 0), vh - BALL_SIZE)
  dragXY.value = { x, y }
  overDrop.value = inDropZone(x, y, vw, vh)
}
/** 松手：点击回工具；投放区内关闭浮窗；否则吸边并记位置 */
function onUp(): void {
  if (!start) return
  const wasMoved = moved
  const xy = dragXY.value
  const hit = overDrop.value
  start = null
  moved = false
  dragXY.value = null
  overDrop.value = false
  if (!wasMoved) {
    if (float.floating) void router.push(`/tool/${float.floating.id}`)
    return
  }
  if (hit) {
    float.close()
    return
  }
  if (xy) {
    pos.value = { side: snapSide(xy.x, window.innerWidth), y: clampY(xy.y, window.innerHeight) }
    savePos(pos.value)
  }
}
/** 指针被系统取消（如来电）：当作普通松手但不触发点击 */
function onCancel(): void {
  moved = true
  onUp()
}
</script>

<template>
  <template v-if="visible">
    <!-- 投放区：只在拖动时出现，球进入后放大高亮 -->
    <div
      v-if="dragXY"
      class="float-drop"
      :class="{ 'float-drop--on': overDrop }"
      :style="{ width: `${DROP_SIZE}px`, height: `${DROP_SIZE}px`, bottom: `${DROP_BOTTOM}px`, zIndex: FLOAT_Z - 1 }"
    >
      <van-icon name="cross" />
      <span>{{ DROP_LABEL }}</span>
    </div>
    <button
      type="button"
      class="float-ball"
      :class="{ 'float-ball--drag': !!dragXY }"
      :style="ballStyle"
      :aria-label="label"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onCancel"
    >
      <span class="float-ball__icon">{{ icon }}</span>
    </button>
  </template>
</template>

<style scoped>
.float-ball {
  position: fixed;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--c-text);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 50%;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  /* 松手吸边的动画；拖动中必须关掉，否则跟手有延迟 */
  transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.float-ball--drag {
  transition: none;
  opacity: 0.92;
}

.float-ball__icon {
  font-size: 24px;
  line-height: 1;
}

.float-drop {
  position: fixed;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 12px;
  color: #fff;
  background: rgba(30, 32, 38, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 50%;
  transform: translateX(-50%) scale(1);
  transition:
    transform 0.15s ease,
    background 0.15s ease;
  pointer-events: none;
}

.float-drop--on {
  background: var(--c-error);
  transform: translateX(-50%) scale(1.25);
}
</style>
