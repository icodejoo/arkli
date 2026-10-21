<script setup lang="ts">
// 指南针：读浏览器的方向事件，罗盘盘面随航向反向旋转
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useFloatPause } from '@/shared/useFloatPause'
import { createAppAwake } from '../clock-screen/awake'
import { createCompassSession, directionName, normalizeDeg, startCompass, type CompassStatus, type EventSourceLike } from './logic'

/** 盘面上的刻度间隔（度） */
const TICK_STEP = 30
/** 盘面四个主方位 */
const CARDINALS = [
  { label: '北', deg: 0 },
  { label: '东', deg: 90 },
  { label: '南', deg: 180 },
  { label: '西', deg: 270 },
] as const
/** 盘面刻度角度列表 */
const TICKS = Array.from({ length: 360 / TICK_STEP }, (_, i) => i * TICK_STEP)
/** 无传感器时的提示 */
const TIP_UNSUPPORTED = '没有读到方向传感器的数据：设备可能没有磁力计，或系统限制了网页读取。'
/** iOS 式权限请求的类型 */
type PermissionApi = { requestPermission?: () => Promise<'granted' | 'denied'> }

/** 当前状态 */
const status = ref<CompassStatus>('idle')
/** 平滑后的航向（度） */
const heading = ref(0)
/** 是否被用户拒绝权限 */
const denied = ref(false)
/** 监听会话；授权弹窗是异步的，回调回来时组件可能已卸载，会话会拒绝再开始 */
const session = createCompassSession(() =>
  startCompass({
    target: window as unknown as EventSourceLike,
    getScreenAngle: screenAngle,
    onHeading: (d) => (heading.value = d),
    onStatus: (s) => (status.value = s),
  }),
)

/** 是否需要先点按钮请求权限（iOS 的做法） */
const needPermission = computed(() => typeof (window.DeviceOrientationEvent as unknown as PermissionApi | undefined)?.requestPermission === 'function')
/** 航向度数文本 */
const degText = computed(() => `${Math.round(normalizeDeg(heading.value)) % 360}°`)
/** 方位名 */
const dirText = computed(() => directionName(heading.value))
/** 盘面旋转样式 */
const dialStyle = computed(() => ({ transform: `rotate(${-heading.value}deg)` }))

/** 读当前屏幕旋转角，读不到当 0 */
function screenAngle(): number {
  return window.screen?.orientation?.angle ?? 0
}

/** 点击授权按钮：请求权限，通过后开始监听 */
async function askPermission(): Promise<void> {
  const api = window.DeviceOrientationEvent as unknown as PermissionApi
  try {
    const r = await api.requestPermission?.()
    if (r === 'granted') {
      denied.value = false
      session.begin()
    } else {
      denied.value = true
    }
  } catch {
    denied.value = true
  }
}

if (needPermission.value) status.value = 'idle'
else session.begin()

/** 常亮控制器：看指南针时不让屏幕熄掉 */
const awake = createAppAwake()
onMounted(() => void awake.acquire())
// 浮起时取消方向订阅并释放常亮，取回时按浮起前状态重订
useFloatPause({
  pause: () => {
    session.pause()
    void awake.release()
  },
  resume: () => {
    session.resume()
    void awake.acquire()
  },
})
onUnmounted(() => {
  session.dispose()
  void awake.release()
})
</script>

<template>
  <div class="tool-page">
    <tool-group class="compass-card">
      <div class="compass" :class="{ 'compass--off': status !== 'ok' }">
        <div class="compass__pointer" />
        <div class="compass__dial" :style="dialStyle">
          <span v-for="d in TICKS" :key="d" class="compass__tick" :class="{ 'compass__tick--major': d % 90 === 0 }" :style="{ transform: `rotate(${d}deg)` }" />
          <span
            v-for="c in CARDINALS"
            :key="c.label"
            class="compass__card"
            :class="{ 'compass__card--n': c.deg === 0 }"
            :style="{ transform: `rotate(${c.deg}deg) translateY(-80px) rotate(${-c.deg}deg)` }"
            >{{ c.label }}</span
          >
        </div>
      </div>
      <div class="tool-result compass__read">
        <template v-if="status === 'ok'">{{ dirText }} {{ degText }}</template>
        <template v-else>--</template>
      </div>
    </tool-group>

    <tool-group v-if="needPermission && status === 'idle'">
      <p class="tool-hint">这个系统要先授权才能读方向传感器。</p>
      <van-button type="primary" block round @click="askPermission">授权并开始</van-button>
      <p v-if="denied" class="tool-hint compass__warn">授权被拒绝了，请到系统设置里允许「动作与方向」访问后重试。</p>
    </tool-group>
    <div v-else-if="status === 'waiting'" class="tool-hint">正在读取传感器...</div>
    <div v-else-if="status === 'unsupported'" class="tool-hint compass__warn">{{ TIP_UNSUPPORTED }}</div>

    <tool-group title="使用小提示">
      <p class="tool-hint">手机尽量放平。远离磁铁、金属、音箱和手机壳磁扣；读数乱跳时，拿着手机在空中画几个 8 字来校准。</p>
      <p class="tool-hint">这里指的是磁北，与地理正北有几度偏差（磁偏角），导航级用途请别依赖。</p>
    </tool-group>
  </div>
</template>

<style lang="scss" scoped>
/* 卡片内居中 */
.compass-card {
  text-align: center;
}

/* 罗盘外框：圆形，内部绝对定位 */
.compass {
  position: relative;
  width: 240px;
  height: 240px;
  margin: $space-2 auto $space-3;
  border: 2px solid var(--c-border);
  border-radius: 50%;
  background: var(--c-bg);

  /* 没数据时盘面压暗 */
  &--off {
    opacity: 0.45;
  }

  /* 顶部固定指针 */
  &__pointer {
    position: absolute;
    top: -8px;
    left: 50%;
    z-index: 1;
    margin-left: -8px;
    border-right: 8px solid transparent;
    border-left: 8px solid transparent;
    border-top: 16px solid var(--c-error);
  }

  /* 随航向旋转的盘面 */
  &__dial {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    will-change: transform;
  }

  /* 刻度：从圆心向外放置一根细线 */
  &__tick {
    position: absolute;
    top: 0;
    left: 50%;
    width: 1px;
    height: 120px;
    margin-left: -0.5px;
    transform-origin: 50% 100%;

    &::before {
      content: '';
      display: block;
      width: 100%;
      height: 8px;
      background: var(--c-text-muted);
    }

    &--major::before {
      width: 2px;
      height: 14px;
      margin-left: -0.5px;
      background: var(--c-text);
    }
  }

  /* 方位字：定位到圆心再平移到边缘 */
  &__card {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 24px;
    height: 24px;
    margin: -12px 0 0 -12px;
    font-size: 18px;
    font-weight: 600;
    line-height: 24px;
    color: var(--c-text);

    &--n {
      color: var(--c-error);
    }
  }

  /* 读数 */
  &__read {
    padding: $space-2;
    background: transparent;
  }

  /* 警示提示 */
  &__warn {
    margin-top: $space-2;
    color: var(--c-warn-text);
  }
}
</style>
