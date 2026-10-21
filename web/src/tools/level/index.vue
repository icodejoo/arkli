<script setup lang="ts">
// 水平仪：读重力方向，圆形气泡看平放，条形看立放；可校准零点、锁定读数
import BottomActions from '@/shared/BottomActions.vue'
import { useFloatPause } from '@/shared/useFloatPause'
import { computed, onBeforeUnmount, ref } from 'vue'
import { applyZero, bubbleOffset, createPausableListener, foldToQuarter, formatDeg, inPlaneAngle, isSteady, startGravity, tiltFromGravity, totalTilt, type MotionSourceLike, type MotionStatus, type Tilt, type Vec3 } from './logic'

/** 立放判定：总倾斜超过这个角度走条形的平面内算法 */
const STANDING_DEG = 45
/** 视为水平的容差（度），在内则变绿 */
const LEVEL_TOL = 0.5
/** 圆形气泡活动半径（像素），要小于盘面半径减气泡半径 */
const BUBBLE_RADIUS = 90
/** 条形气泡活动半幅（像素） */
const BAR_HALF = 120
/** 无传感器时的提示 */
const TIP_UNSUPPORTED = '没读到重力传感器的数据：设备可能没有加速度计，或系统限制了网页读取。'
/** 模式：圆形气泡 / 条形 */
type Mode = 'bubble' | 'bar'
/** iOS 式权限请求的类型 */
type PermissionApi = { requestPermission?: () => Promise<'granted' | 'denied'> }

/** 当前模式 */
const mode = ref<Mode>('bubble')
/** 传感器状态 */
const status = ref<MotionStatus>('waiting')
/** 滤波后的重力读数 */
const vec = ref<Vec3 | null>(null)
/** 校准零点（俯仰/横滚） */
const zero = ref<Tilt | null>(null)
/** 条形模式的零点偏移 */
const zeroBar = ref(0)
/** 锁定住的读数；有值时界面不再刷新 */
const locked = ref<{ tilt: Tilt; bar: number; standing: boolean } | null>(null)
/** 是否被拒绝权限 */
const denied = ref(false)

/** 是否需要先点按钮授权（iOS 的做法） */
const needPermission = computed(() => typeof (window.DeviceMotionEvent as unknown as PermissionApi | undefined)?.requestPermission === 'function')
/** 是否已经开始监听或在等授权 */
const awaiting = ref(needPermission.value)

/** 实时读数（已扣零点）；没数据时为 null */
const live = computed(() => {
  const v = vec.value
  if (!v) return null
  const standing = totalTilt(v) > STANDING_DEG
  const raw = tiltFromGravity(v, needPermission.value)
  const bar = foldToQuarter(inPlaneAngle(needPermission.value ? { x: -v.x, y: -v.y, z: -v.z } : v)) - zeroBar.value
  return { tilt: applyZero(raw, zero.value), bar: standing ? bar : applyZero(raw, zero.value).roll, standing }
})
/** 当前展示的读数：锁定优先 */
const shown = computed(() => locked.value ?? live.value)
/** 晃动中，读数不稳 */
const shaky = computed(() => !!vec.value && !isSteady(vec.value))
/** 是否已水平 */
const isLevel = computed(() => {
  const s = shown.value
  if (!s) return false
  return mode.value === 'bar' ? Math.abs(s.bar) <= LEVEL_TOL : Math.abs(s.tilt.pitch) <= LEVEL_TOL && Math.abs(s.tilt.roll) <= LEVEL_TOL
})
/** 圆形气泡位置：横滚向右抬起时气泡向左跑（气泡往高处走），俯仰同理 */
const bubbleStyle = computed(() => {
  const s = shown.value
  const dx = s ? -bubbleOffset(s.tilt.roll) : 0
  const dy = s ? bubbleOffset(s.tilt.pitch) : 0
  return { transform: `translate(${dx * BUBBLE_RADIUS}px, ${dy * BUBBLE_RADIUS}px)` }
})
/** 条形气泡位置 */
const barStyle = computed(() => {
  const s = shown.value
  const dx = s ? bubbleOffset(s.bar) : 0
  return { transform: `translateX(${dx * BAR_HALF}px)` }
})

/** 可暂停的重力监听；校准零点、锁定读数都在本组件状态里，暂停不会丢 */
const listener = createPausableListener(() =>
  startGravity({
    target: window as unknown as MotionSourceLike,
    onVector: (v) => (vec.value = v),
    onStatus: (s) => (status.value = s),
  }),
)

/** 开始监听 */
function begin(): void {
  listener.begin()
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

/** 把当前位置设为零点；再点一次清除 */
function calibrate(): void {
  if (zero.value || zeroBar.value) {
    zero.value = null
    zeroBar.value = 0
    return
  }
  const v = vec.value
  if (!v) return
  zero.value = tiltFromGravity(v, needPermission.value)
  zeroBar.value = foldToQuarter(inPlaneAngle(needPermission.value ? { x: -v.x, y: -v.y, z: -v.z } : v))
}

/** 锁定/解锁当前读数 */
function toggleLock(): void {
  locked.value = locked.value ? null : live.value ? { ...live.value } : null
}

if (!needPermission.value) begin()
// 浮起时取消重力订阅，取回时重订
useFloatPause({ pause: () => listener.pause(), resume: () => listener.resume() })
onBeforeUnmount(() => listener.end())
</script>

<template>
  <div class="tool-page">
    <tool-group class="level-card">
      <van-tabs v-model:active="mode" type="card" class="level__tabs">
        <van-tab title="圆形" name="bubble" />
        <van-tab title="条形" name="bar" />
      </van-tabs>

      <div v-if="mode === 'bubble'" class="level__disc" :class="{ 'level__disc--ok': isLevel, 'level__disc--off': !shown }">
        <span class="level__cross level__cross--h" />
        <span class="level__cross level__cross--v" />
        <span class="level__ring" />
        <span class="level__bubble" :style="bubbleStyle" />
      </div>
      <div v-else class="level__bar" :class="{ 'level__bar--ok': isLevel, 'level__bar--off': !shown }">
        <span class="level__mid" />
        <span class="level__bubble level__bubble--bar" :style="barStyle" />
      </div>

      <div class="tool-result level__read">
        <template v-if="shown && mode === 'bubble'">俯仰 {{ formatDeg(shown.tilt.pitch) }} / 横滚 {{ formatDeg(shown.tilt.roll) }}</template>
        <template v-else-if="shown">{{ formatDeg(shown.bar) }}</template>
        <template v-else>--</template>
      </div>
      <p v-if="locked" class="tool-hint">读数已锁定</p>
      <p v-else-if="shaky" class="tool-hint level__warn">手机在晃动，读数仅供参考</p>
      <p v-else-if="mode === 'bar' && shown && !shown.standing" class="tool-hint">手机平放时条形显示的是横滚角，立起来再测水平线更准。</p>
    </tool-group>

    <tool-group v-if="awaiting">
      <p class="tool-hint">这个系统要先授权才能读动作传感器，点底部「授权并开始」。</p>
      <p v-if="denied" class="tool-hint level__warn">授权被拒绝了，请到系统设置里允许「动作与方向」访问后重试。</p>
    </tool-group>
    <div v-else-if="status === 'waiting'" class="tool-hint">正在读取传感器...</div>
    <div v-else-if="status === 'unsupported'" class="tool-hint level__warn">{{ TIP_UNSUPPORTED }}</div>

    <van-button block round plain :disabled="!vec" @click="calibrate">{{ zero || zeroBar ? '清除校准' : '校准零点' }}</van-button>

    <tool-group title="使用小提示">
      <p class="tool-hint">先在一个确认水平的桌面上点「校准零点」，之后的读数就是相对这个面的偏差。把手机转 180 度再看，读数应当正负对称，不对称就说明零点偏了。</p>
      <p class="tool-hint">手机壳、摄像头凸起会让平放的手机本身就有点斜，量精细的东西请贴着边测。</p>
    </tool-group>

    <!-- 底部动作栏：主按钮锁定 / 解除锁定读数（传感器仍持续运行）；需要授权时先显示「授权并开始」；校准零点是次要操作，留在页内 -->
    <bottom-actions
      main
      :main-text="awaiting ? '授权并开始' : locked ? '解除锁定' : '锁定读数'"
      :disabled="{ main: !awaiting && !shown }"
      @main="awaiting ? askPermission() : toggleLock()"
    />
  </div>
</template>

<style lang="scss" scoped>
/* 卡片内居中 */
.level-card {
  text-align: center;
}

/* 模式切换条 */
.level__tabs {
  margin-bottom: $space-3;
}

/* 圆形盘面 */
.level__disc {
  position: relative;
  width: 240px;
  height: 240px;
  margin: 0 auto $space-3;
  border: 2px solid var(--c-border);
  border-radius: 50%;
  background: var(--c-bg);

  /* 水平时盘面描绿 */
  &--ok {
    border-color: var(--c-success, #07c160);
  }

  /* 没数据时压暗 */
  &--off {
    opacity: 0.45;
  }
}

/* 十字准线 */
.level__cross {
  position: absolute;
  background: var(--c-border);

  &--h {
    top: 50%;
    right: 0;
    left: 0;
    height: 1px;
  }

  &--v {
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
  }
}

/* 中心目标圈 */
.level__ring {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 40px;
  height: 40px;
  margin: -20px 0 0 -20px;
  border: 2px solid var(--c-text-muted);
  border-radius: 50%;
}

/* 气泡：定位在圆心，用 transform 偏移 */
.level__bubble {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 32px;
  height: 32px;
  margin: -16px 0 0 -16px;
  border-radius: 50%;
  background: var(--c-primary, #1989fa);
  opacity: 0.8;

  /* 条形里的气泡更窄长 */
  &--bar {
    width: 48px;
    height: 28px;
    margin: -14px 0 0 -24px;
    border-radius: 14px;
  }
}

/* 条形管 */
.level__bar {
  position: relative;
  width: 100%;
  max-width: 300px;
  height: 56px;
  margin: $space-3 auto;
  border: 2px solid var(--c-border);
  border-radius: 28px;
  background: var(--c-bg);

  &--ok {
    border-color: var(--c-success, #07c160);
  }

  &--off {
    opacity: 0.45;
  }
}

/* 条形中线 */
.level__mid {
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 50%;
  width: 1px;
  background: var(--c-text-muted);
}

/* 读数 */
.level__read {
  padding: $space-2;
  background: transparent;
}

/* 警示提示 */
.level__warn {
  color: var(--c-warn-text);
}
</style>
