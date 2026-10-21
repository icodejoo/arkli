<script setup lang="ts">
// 量角器：屏上拖两条射线读夹角；倾角模式读手机的倾斜角（复用水平仪的算法）
import BottomActions from '@/shared/BottomActions.vue'
import CellPicker from '@/shared/CellPicker.vue'
import { useFloatPause } from '@/shared/useFloatPause'
import type { CellOption } from '@/shared/cellPicker'
import { computed, onBeforeUnmount, ref } from 'vue'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { isBool, oneOf } from '@/shared/persistValidators'
import { createPausableListener, isSteady, startGravity, type MotionSourceLike, type MotionStatus, type Vec3 } from '../level/logic'
import { clampAngle, clientToView, DIAL_VALUES, edgeInclination, FULL_CIRCLE, HALF_CIRCLE, includedAngle, nearestRay, pointAngle, polar, SNAP_STEP, snapAngle, STORE_NS, surfaceInclination, sweepAngle, TILT_KIND_VALUES, type DialMode, type Point } from './logic'

/** 主模式：屏上量角 / 倾角 */
type Mode = 'screen' | 'tilt'
/** 倾角子模式：贴边 / 贴面 */
type TiltKind = 'edge' | 'surface'
/** iOS 式权限请求的类型 */
type PermissionApi = { requestPermission?: () => Promise<'granted' | 'denied'> }

/** 视图宽 */
const VIEW_W = 300
/** 量角器半径 */
const RADIUS = 130
/** 半圆盘面视图高 */
const HALF_H = 170
/** 全圆盘面视图高 */
const FULL_H = 300
/** 刻度小步长（度） */
const TICK_MINOR = 5
/** 刻度大步长（度） */
const TICK_MAJOR = 30
/** 小刻度长度 */
const TICK_MINOR_LEN = 6
/** 大刻度长度 */
const TICK_MAJOR_LEN = 12
/** 数字标在半径内侧的距离 */
const LABEL_INSET = 26
/** 拖动点半径 */
const HANDLE_R = 12
/** 度数文字：整数时不带小数 */
const DEG_DIGITS = 1
/** 无传感器提示 */
const TIP_UNSUPPORTED = '没读到重力传感器的数据：设备可能没有加速度计，或系统限制了网页读取。'

/** 持久缓存 */
const store = createToolStorage(STORE_NS)
/** 主模式（倾角模式要启动传感器，不持久化） */
const mode = ref<Mode>('screen')
/** 盘面：半圆/全圆 */
const dial = usePersistedRef<DialMode>(store, 'dial', 'half', oneOf(DIAL_VALUES))
/** 盘面选项 */
const DIAL_OPTIONS: CellOption[] = [
  { value: 'half', label: '半圆' },
  { value: 'full', label: '全圆' },
]
/** 两条射线方向角 */
const rays = ref<[number, number]>([0, 60])
/** 是否吸附到 5 度 */
const snap = usePersistedRef(store, 'snap', false, isBool)
/** 正在拖的射线下标，-1 表示没在拖 */
const dragging = ref(-1)
/** SVG 元素引用 */
const svgEl = ref<SVGSVGElement | null>(null)

/** 倾角子模式 */
const tiltKind = usePersistedRef<TiltKind>(store, 'tiltKind', 'edge', oneOf(TILT_KIND_VALUES))
/** 传感器状态 */
const status = ref<MotionStatus>('waiting')
/** 滤波后的重力读数 */
const vec = ref<Vec3 | null>(null)
/** 是否被拒绝权限 */
const denied = ref(false)
/** 倾角读数已锁定的值 */
const lockedTilt = ref<number | null>(null)

/** 是否需要先点按钮授权（iOS 的做法） */
const needPermission = computed(() => typeof (window.DeviceMotionEvent as unknown as PermissionApi | undefined)?.requestPermission === 'function')
/** 是否在等授权 */
const awaiting = ref(false)

/** 圆心 */
const center = computed<Point>(() => ({ x: VIEW_W / 2, y: dial.value === 'half' ? HALF_H - 15 : FULL_H / 2 }))
/** 视图高 */
const viewH = computed(() => (dial.value === 'half' ? HALF_H : FULL_H))
/** 刻度范围上限（度） */
const tickMax = computed(() => (dial.value === 'half' ? HALF_CIRCLE : FULL_CIRCLE))
/** 刻度线（含大刻度数字） */
const ticks = computed(() => {
  const out: { x1: number; y1: number; x2: number; y2: number; major: boolean; label?: { x: number; y: number; text: number } }[] = []
  for (let d = 0; d < tickMax.value + (dial.value === 'half' ? 1 : 0); d += TICK_MINOR) {
    const major = d % TICK_MAJOR === 0
    const a = polar(center.value, RADIUS, d)
    const b = polar(center.value, RADIUS - (major ? TICK_MAJOR_LEN : TICK_MINOR_LEN), d)
    const t = polar(center.value, RADIUS - LABEL_INSET, d)
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, major, label: major ? { x: t.x, y: t.y, text: d } : undefined })
  }
  return out
})
/** 两条射线端点 */
const ends = computed(() => rays.value.map((d) => polar(center.value, RADIUS, d)))
/** 读数：半圆为夹角，全圆为 A 逆时针转到 B 的角度 */
const angle = computed(() => (dial.value === 'half' ? includedAngle(rays.value[0], rays.value[1]) : sweepAngle(rays.value[0], rays.value[1])))
/** 全圆下的另一侧（优角/劣角） */
const otherSide = computed(() => FULL_CIRCLE - angle.value)
/** 夹角扇形路径（A 逆时针到 B，半圆取小侧） */
const wedge = computed(() => {
  const [a, b] = rays.value
  const r = 36
  const start = polar(center.value, r, dial.value === 'half' && sweepAngle(a, b) > HALF_CIRCLE ? b : a)
  const end = polar(center.value, r, dial.value === 'half' && sweepAngle(a, b) > HALF_CIRCLE ? a : b)
  const sweep = dial.value === 'half' ? includedAngle(a, b) : sweepAngle(a, b)
  const c = center.value
  return `M ${c.x} ${c.y} L ${start.x} ${start.y} A ${r} ${r} 0 ${sweep > HALF_CIRCLE ? 1 : 0} 0 ${end.x} ${end.y} Z`
})

/** 倾角实时读数（立刻按子模式换算）；没数据为 null */
const liveTilt = computed(() => {
  const v = vec.value
  if (!v) return null
  // iOS 的读数符号相反，取反后与 Android 约定一致
  const w = needPermission.value ? { x: -v.x, y: -v.y, z: -v.z } : v
  return tiltKind.value === 'edge' ? edgeInclination(w) : surfaceInclination(w)
})
/** 当前展示的倾角 */
const shownTilt = computed(() => lockedTilt.value ?? liveTilt.value)
/** 晃动中 */
const shaky = computed(() => !!vec.value && !isSteady(vec.value))

/**
 * 格式化度数。
 *
 * @param d 角度
 * @returns 如 "45.0°"
 */
function fmt(d: number): string {
  return `${d.toFixed(DEG_DIGITS)}°`
}

/**
 * 把指针事件换算成相对圆心的方向角。
 *
 * @param e 指针事件
 * @returns 方向角；拿不到或点在圆心上时为 null
 */
function angleOf(e: PointerEvent): number | null {
  const el = svgEl.value
  if (!el) return null
  const p = clientToView({ x: e.clientX, y: e.clientY }, el.getBoundingClientRect(), VIEW_W, viewH.value)
  return p ? pointAngle(center.value, p) : null
}

/** 按下：选最近的射线开始拖 */
function onDown(e: PointerEvent): void {
  const a = angleOf(e)
  if (a === null) return
  dragging.value = nearestRay(rays.value, a)
  svgEl.value?.setPointerCapture?.(e.pointerId)
  onMove(e)
}

/** 移动：更新被拖射线 */
function onMove(e: PointerEvent): void {
  const i = dragging.value
  if (i < 0) return
  const a = angleOf(e)
  if (a === null) return
  const next = clampAngle(snap.value ? snapAngle(a, SNAP_STEP) : a, dial.value)
  const r: [number, number] = [rays.value[0], rays.value[1]]
  r[i] = next
  rays.value = r
}

/** 抬起或取消：结束拖动 */
function onUp(): void {
  dragging.value = -1
}

/** 切换盘面时，把射线夹进新盘面范围 */
function setDial(d: DialMode): void {
  dial.value = d
  rays.value = [clampAngle(rays.value[0], d), clampAngle(rays.value[1], d)]
}

/** 可暂停的重力监听；锁定读数在 lockedTilt 里，暂停不清 */
const listener = createPausableListener(() =>
  startGravity({
    target: window as unknown as MotionSourceLike,
    onVector: (v) => (vec.value = v),
    onStatus: (s) => (status.value = s),
  }),
)

/** 开始监听重力（仅进入倾角模式时） */
function begin(): void {
  listener.begin()
}

/** 停止监听并清空数据 */
function end(): void {
  listener.end()
  vec.value = null
  lockedTilt.value = null
}

/** 点授权按钮：请求权限，通过后开始监听 */
async function askPermission(): Promise<void> {
  try {
    const r = await (window.DeviceMotionEvent as unknown as PermissionApi).requestPermission?.()
    if (r === 'granted') {
      denied.value = false
      awaiting.value = false
      begin()
    } else denied.value = true
  } catch {
    denied.value = true
  }
}

/** 切主模式：进倾角才开传感器，离开就关 */
function setMode(m: Mode): void {
  mode.value = m
  if (m === 'tilt') {
    if (needPermission.value) awaiting.value = true
    else begin()
  } else {
    awaiting.value = false
    end()
  }
}

/** 锁定/解锁倾角读数 */
function toggleLock(): void {
  lockedTilt.value = lockedTilt.value === null ? liveTilt.value : null
}

// 浮起时取消重力订阅（不清锁定读数），取回时仅在倾角模式下重订
useFloatPause({ pause: () => listener.pause(), resume: () => listener.resume() })
onBeforeUnmount(end)
</script>

<template>
  <div class="tool-page">
    <van-tabs :active="mode" type="card" @change="(n: string | number) => setMode(n as Mode)">
      <van-tab title="屏上量角" name="screen" />
      <van-tab title="倾角" name="tilt" />
    </van-tabs>

    <template v-if="mode === 'screen'">
      <tool-group class="pro-card">
        <svg
          ref="svgEl"
          class="pro__svg"
          :viewBox="`0 0 ${VIEW_W} ${viewH}`"
          @pointerdown.prevent="onDown"
          @pointermove.prevent="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
        >
          <path :d="wedge" class="pro__wedge" />
          <g class="pro__scale">
            <circle v-if="dial === 'full'" :cx="center.x" :cy="center.y" :r="RADIUS" class="pro__rim" />
            <path v-else :d="`M ${center.x - RADIUS} ${center.y} A ${RADIUS} ${RADIUS} 0 0 1 ${center.x + RADIUS} ${center.y} Z`" class="pro__rim" />
            <template v-for="t in ticks" :key="t.label ? `m${t.label.text}` : `${t.x1},${t.y1}`">
              <line :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2" :class="t.major ? 'pro__tick pro__tick--major' : 'pro__tick'" />
              <text v-if="t.label" :x="t.label.x" :y="t.label.y" class="pro__num" text-anchor="middle" dominant-baseline="middle">{{ t.label.text }}</text>
            </template>
          </g>
          <template v-for="(p, i) in ends" :key="i">
            <line :x1="center.x" :y1="center.y" :x2="p.x" :y2="p.y" :class="i === 0 ? 'pro__ray pro__ray--a' : 'pro__ray pro__ray--b'" />
            <circle :cx="p.x" :cy="p.y" :r="HANDLE_R" :class="[i === 0 ? 'pro__handle pro__handle--a' : 'pro__handle pro__handle--b', { 'pro__handle--on': dragging === i }]" />
          </template>
          <circle :cx="center.x" :cy="center.y" r="4" class="pro__pivot" />
        </svg>
        <div class="tool-result pro__read">
          {{ fmt(angle) }}
          <span v-if="dial === 'full'" class="tool-result__label">另一侧 {{ fmt(otherSide) }}（从红线逆时针转到蓝线）</span>
        </div>
      </tool-group>
      <tool-group>
        <van-cell-group>
          <cell-picker :model-value="dial" title="盘面" :options="DIAL_OPTIONS" @update:model-value="setDial($event as DialMode)" />
          <van-cell title="吸附到 5 度" center>
            <van-switch v-model="snap" size="20" />
          </van-cell>
        </van-cell-group>
        <p class="tool-hint">拖动圆点转动射线，哪条离手指近就动哪条。读数只和角度有关，跟屏幕尺寸无关。</p>
      </tool-group>
    </template>

    <template v-else>
      <tool-group class="pro-card">
        <van-tabs :active="tiltKind" type="card" @change="(n: string | number) => (tiltKind = n as TiltKind)">
          <van-tab title="贴边测量" name="edge" />
          <van-tab title="贴面测量" name="surface" />
        </van-tabs>
        <div class="tool-result pro__read">{{ shownTilt === null ? '--' : fmt(shownTilt) }}</div>
        <p v-if="lockedTilt !== null" class="tool-hint">读数已锁定</p>
        <p v-else-if="shaky" class="tool-hint pro__warn">手机在晃动，读数仅供参考</p>
        <p class="tool-hint">{{ tiltKind === 'edge' ? '手机立起来，让长边贴着要量的物体，读数是这条边与水平线的夹角。' : '把手机平贴在斜面上，读数是斜面与水平面的夹角。' }}</p>
      </tool-group>

      <tool-group v-if="awaiting">
        <p class="tool-hint">这个系统要先授权才能读动作传感器，点底部「授权并开始」。</p>
        <p v-if="denied" class="tool-hint pro__warn">授权被拒绝了，请到系统设置里允许「动作与方向」访问后重试。</p>
      </tool-group>
      <div v-else-if="status === 'waiting'" class="tool-hint">正在读取传感器...</div>
      <div v-else-if="status === 'unsupported'" class="tool-hint pro__warn">{{ TIP_UNSUPPORTED }}</div>

      <p class="tool-hint">不同机型传感器零点略有差异，量之前可以先在水平桌面上看看读数是不是 0。</p>
    </template>

    <!-- 底部动作栏：只在「倾角」页出现，主按钮锁定 / 解除锁定读数；需要授权时先显示「授权并开始」 -->
    <bottom-actions
      v-if="mode === 'tilt'"
      main
      :main-text="awaiting ? '授权并开始' : lockedTilt === null ? '锁定读数' : '解除锁定'"
      :disabled="{ main: !awaiting && shownTilt === null }"
      @main="awaiting ? askPermission() : toggleLock()"
    />
  </div>
</template>

<style lang="scss" scoped>
/* 卡片内居中 */
.pro-card {
  text-align: center;
}

/* 量角器画布：禁止浏览器接管触摸手势，否则拖动会变成滚动 */
.pro__svg {
  display: block;
  width: 100%;
  max-width: 360px;
  margin: 0 auto;
  touch-action: none;
  user-select: none;
}

/* 盘面外框 */
.pro__rim {
  fill: var(--c-bg);
  stroke: var(--c-border);
  stroke-width: 2;
}

/* 刻度 */
.pro__tick {
  stroke: var(--c-text-muted);
  stroke-width: 1;

  &--major {
    stroke: var(--c-text);
    stroke-width: 1.5;
  }
}

/* 刻度数字 */
.pro__num {
  font-size: 10px;
  fill: var(--c-text-muted);
}

/* 夹角扇形 */
.pro__wedge {
  fill: var(--c-primary);
  opacity: 0.25;
}

/* 射线 */
.pro__ray {
  stroke-width: 2.5;
  stroke-linecap: round;

  &--a {
    stroke: var(--c-error);
  }

  &--b {
    stroke: var(--c-primary);
  }
}

/* 拖动点 */
.pro__handle {
  fill: var(--c-surface);
  stroke-width: 3;
  cursor: grab;

  &--a {
    stroke: var(--c-error);
  }

  &--b {
    stroke: var(--c-primary);
  }

  /* 正在拖动时放大 */
  &--on {
    fill: var(--c-bg);
  }
}

/* 圆心 */
.pro__pivot {
  fill: var(--c-text);
}

/* 读数 */
.pro__read {
  padding: $space-2;
  background: transparent;
}

/* 警示提示 */
.pro__warn {
  color: var(--c-warn-text);
}
</style>
