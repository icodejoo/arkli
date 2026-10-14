<script setup lang="ts">
// 指尖轮盘：多人手指按在屏幕上，稳定 3 秒后随机选人 / 排先手 / 分两队
import { computed, onBeforeUnmount, ref } from 'vue'
import { assignRoles, canCountdown, colorFor, COUNTDOWN_MS, hasMoved, MAX_FINGERS, MODE_LABEL, type Assignment, type Mode, type Point } from './logic'

/** 一个正在按着的手指 */
interface Finger extends Point {
  /** 触点 id */
  id: number
  /** 颜色序号（按下顺序，抬起后不复用到其他手指之前保持稳定） */
  slot: number
}

/** 模式选项 */
const MODES = Object.keys(MODE_LABEL) as Mode[]

/** 当前模式 */
const mode = ref<Mode>('one')
/** 按着的手指，响应式数组便于渲染 */
const fingers = ref<Finger[]>([])
/** 已出的结果；为空表示还在等 */
const result = ref<Assignment[] | null>(null)
/** 出结果瞬间的手指快照（结果期间手指抬起也要继续显示） */
const snapshot = ref<Finger[]>([])
/** 倒计时是否在跑（驱动 CSS 动画重启） */
const counting = ref(false)
/** 倒计时重启计数，作为 key 让动画从头播 */
const tick = ref(0)

/** 定位基准：触摸区元素 */
const pad = ref<HTMLElement | null>(null)
/** 倒计时计时器 */
let timer: ReturnType<typeof setTimeout> | undefined
/** 上次重新计时时各手指的位置，用来判断是否“动了” */
const anchors = new Map<number, Point>()
/** 已用过的颜色序号计数 */
let nextSlot = 0

/** 屏幕上画的指圈：结果期间画快照，否则画实时手指 */
const rings = computed(() => (result.value ? snapshot.value : fingers.value))
/** 提示文案 */
const hint = computed(() => {
  if (result.value) return '松手后再按一次，重新来过'
  if (!fingers.value.length) return '每人一根手指按在这里，按住别动'
  if (!canCountdown(fingers.value.length)) return '再来一个人按上来'
  return '按住别动，马上选定'
})

/** 取消倒计时 */
function cancelTimer(): void {
  clearTimeout(timer)
  timer = undefined
  counting.value = false
}

/** 记下当前所有手指位置作为“静止基准” */
function resetAnchors(): void {
  anchors.clear()
  for (const f of fingers.value) anchors.set(f.id, { x: f.x, y: f.y })
}

/** 手指变化后重新计时：不足两指就不计 */
function restartCountdown(): void {
  cancelTimer()
  if (result.value || !canCountdown(fingers.value.length)) return
  resetAnchors()
  counting.value = true
  tick.value++
  timer = setTimeout(settle, COUNTDOWN_MS)
}

/** 倒计时到点：定结果 */
function settle(): void {
  timer = undefined
  counting.value = false
  if (!canCountdown(fingers.value.length)) return
  snapshot.value = fingers.value.map((f) => ({ ...f }))
  result.value = assignRoles(
    fingers.value.map((f) => f.id),
    mode.value,
  )
  // 震动是锦上添花，WebView 不支持就算了
  try {
    navigator.vibrate?.(60)
  } catch {
    // 忽略
  }
}

/** 把事件坐标换成触摸区内坐标 */
function localPoint(e: PointerEvent): Point {
  const r = pad.value?.getBoundingClientRect()
  return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
}

/** 手指按下 */
function onDown(e: PointerEvent): void {
  if (fingers.value.some((f) => f.id === e.pointerId) || fingers.value.length >= MAX_FINGERS) return
  // 上一轮的结果还在时，新按下视为重新开始
  if (result.value) {
    result.value = null
    snapshot.value = []
  }
  try {
    pad.value?.setPointerCapture(e.pointerId)
  } catch {
    // 部分环境不支持捕获，不影响主流程
  }
  fingers.value.push({ id: e.pointerId, slot: nextSlot++, ...localPoint(e) })
  restartCountdown()
}

/** 手指移动：超过容差才重新计时，指圈始终跟手 */
function onMove(e: PointerEvent): void {
  const f = fingers.value.find((x) => x.id === e.pointerId)
  if (!f) return
  const p = localPoint(e)
  f.x = p.x
  f.y = p.y
  const a = anchors.get(f.id)
  if (!result.value && counting.value && a && hasMoved(a, p)) restartCountdown()
}

/** 手指抬起或被系统打断 */
function onUp(e: PointerEvent): void {
  const i = fingers.value.findIndex((x) => x.id === e.pointerId)
  if (i < 0) return
  fingers.value.splice(i, 1)
  anchors.delete(e.pointerId)
  if (!result.value) restartCountdown()
  if (!fingers.value.length) nextSlot = 0
}

/** 某个手指的角色（结果出来前为空） */
function roleOf(id: number): Assignment | undefined {
  return result.value?.find((a) => a.id === id)
}

/** 指圈样式类 */
function ringClass(id: number): Record<string, boolean> {
  const a = roleOf(id)
  return {
    'ring--win': a?.role === 'winner',
    'ring--fade': a?.role === 'loser',
    'ring--ranked': a?.role === 'ranked',
    'ring--teamA': a?.role === 'teamA',
    'ring--teamB': a?.role === 'teamB',
    'ring--count': !a && counting.value,
  }
}

/** 指圈里的文字：先手显示顺位，分队显示 A/B，赢家显示“中” */
function ringText(id: number): string {
  const a = roleOf(id)
  if (!a) return ''
  if (mode.value === 'first') return String(a.order)
  if (mode.value === 'teams') return a.role === 'teamA' ? 'A' : 'B'
  return a.role === 'winner' ? '中' : ''
}

onBeforeUnmount(cancelTimer)
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-radio-group v-model="mode" direction="horizontal" :disabled="counting">
        <van-radio v-for="m in MODES" :key="m" :name="m">{{ MODE_LABEL[m] }}</van-radio>
      </van-radio-group>
    </div>

    <div
      ref="pad"
      class="fr-pad"
      @pointerdown.prevent="onDown"
      @pointermove.prevent="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @contextmenu.prevent
    >
      <p class="fr-hint">{{ hint }}</p>
      <span
        v-for="f in rings"
        :key="`${f.id}-${result ? 'r' : tick}`"
        class="ring"
        :class="ringClass(f.id)"
        :style="{ left: `${f.x}px`, top: `${f.y}px`, '--ring-color': colorFor(f.slot), '--count-ms': `${COUNTDOWN_MS}ms` }"
      >
        {{ ringText(f.id) }}
      </span>
    </div>
    <p class="tool-hint">部分手机三指下滑是截屏手势，会抢走触摸；遇到的话在系统设置里关掉。</p>
  </div>
</template>

<style lang="scss" scoped>
/* 触摸区：禁掉滚动、缩放、长按选字，才能稳定收到多指事件 */
.fr-pad {
  position: relative;
  min-height: 60vh;
  overflow: hidden;
  border-radius: var(--tool-card-radius);
  background: var(--c-surface);
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}

/* 中间的提示文字 */
.fr-hint {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: $space-4;
  text-align: center;
  color: var(--c-text-muted);
  pointer-events: none;
}

/* 指圈：以触点为中心；颜色是内容色，不随主题变 */
.ring {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 88px;
  height: 88px;
  margin: -44px 0 0 -44px;
  border: 5px solid var(--ring-color);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  font-size: 32px;
  font-weight: 700;
  pointer-events: none;
  transition: transform 0.3s, opacity 0.3s;

  /* 倒计时中：圈慢慢收紧，提示“快选定了” */
  &--count {
    animation: ring-shrink var(--count-ms) linear forwards;
  }

  /* 选中：放大 */
  &--win {
    transform: scale(1.8);
    background: var(--ring-color);
  }

  /* 落选：淡出 */
  &--fade {
    opacity: 0.2;
  }

  /* 先手排序：全员实心，数字显示顺位 */
  &--ranked {
    background: var(--ring-color);
  }

  /* 分队：A 队实心、B 队空心加粗 */
  &--teamA {
    background: var(--ring-color);
    border-color: #fff;
  }

  &--teamB {
    border-style: dashed;
    border-width: 7px;
  }
}

@keyframes ring-shrink {
  from {
    transform: scale(1.3);
  }

  to {
    transform: scale(0.9);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ring--count {
    animation: none;
  }
}
</style>
