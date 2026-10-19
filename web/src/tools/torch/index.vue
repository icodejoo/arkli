<script setup lang="ts">
// 手电筒：常亮 / SOS / 频闪，用手机后置闪光灯；退出页面或切后台自动关灯
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { setTorch } from '@/native/system'
import { clampStrobeHz, DEFAULT_STROBE_HZ, MAX_STROBE_HZ, MIN_STROBE_HZ, sosSteps, strobeSteps, type TorchStep } from './logic'

/** 模式 */
type Mode = 'steady' | 'sos' | 'strobe'

/** 模式选项 */
const MODES: { id: Mode; name: string }[] = [
  { id: 'steady', name: '常亮' },
  { id: 'sos', name: 'SOS' },
  { id: 'strobe', name: '频闪' },
]
/** 频率滑杆步长（Hz） */
const HZ_STEP = 0.5
/** 无宿主时的提示 */
const TIP_NO_HOST = '手电筒只能在 Arkli App 里使用。'
/** 没有闪光灯时的提示 */
const TIP_NO_FLASH = '这台设备没有可用的后置闪光灯。'
/** 调用失败时的提示 */
const TIP_FAILED = '手电筒打开失败，可能被其他应用占用了相机。'

/** 当前模式 */
const mode = ref<Mode>('steady')
/** 频闪频率 */
const hz = ref(DEFAULT_STROBE_HZ)
/** 是否在运行（常亮时等同于灯亮） */
const running = ref(false)
/** 灯当前是否亮着（SOS / 频闪时随节奏变化） */
const lit = ref(false)

/** 定时器 id */
let timer: ReturnType<typeof setTimeout> | null = null
/** 串行化原生调用，保证最后一次是关灯 */
let chain: Promise<unknown> = Promise.resolve()
/** 运行代数：停止后旧定时器回调直接作废 */
let generation = 0

/** 把开关请求排进队列；失败时提示并停止 */
function send(on: boolean): void {
  chain = chain.then(async () => {
    try {
      const r = await setTorch(on)
      if (on && !r.available) {
        showToast(TIP_NO_FLASH)
        halt()
      }
    } catch {
      if (on) {
        showToast(TIP_FAILED)
        halt()
      }
    }
  })
}

/** 按时序表循环播放亮灭 */
function playSteps(steps: TorchStep[]): void {
  const gen = generation
  let i = 0
  const tick = (): void => {
    if (gen !== generation) return
    const s = steps[i % steps.length]
    lit.value = s.on
    send(s.on)
    i++
    timer = setTimeout(tick, s.ms)
  }
  tick()
}

/** 清掉定时器并让旧回调作废，不发关灯 */
function halt(): void {
  generation++
  if (timer) clearTimeout(timer)
  timer = null
  running.value = false
  lit.value = false
}

/** 开始当前模式 */
function start(): void {
  if (!isNativeAvailable()) {
    showToast(TIP_NO_HOST)
    return
  }
  running.value = true
  if (mode.value === 'steady') {
    lit.value = true
    send(true)
  } else {
    playSteps(mode.value === 'sos' ? sosSteps() : strobeSteps(hz.value))
  }
}

/** 停止并关灯 */
function stop(): void {
  const wasRunning = running.value || lit.value
  halt()
  if (wasRunning) send(false)
}

/** 大按钮：开 / 关 */
function toggle(): void {
  if (running.value) stop()
  else start()
}

/** 切模式：运行中先停，免得换节奏时串灯 */
function pickMode(m: Mode): void {
  if (mode.value === m) return
  stop()
  mode.value = m
}

/** 频率改动：运行中的频闪立即换节奏 */
function onHzChange(v: number): void {
  hz.value = clampStrobeHz(v)
  if (running.value && mode.value === 'strobe') {
    halt()
    start()
  }
}

/** 切到后台就关灯（原生 onStop 也会兜底） */
function onVisibility(): void {
  if (document.hidden) stop()
}

onMounted(() => document.addEventListener('visibilitychange', onVisibility))
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  halt()
  if (isNativeAvailable()) send(false)
})
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <div class="torch__modes">
        <van-button v-for="m in MODES" :key="m.id" size="small" round :type="mode === m.id ? 'primary' : 'default'" @click="pickMode(m.id)">{{ m.name }}</van-button>
      </div>
      <div class="torch__stage">
        <button type="button" class="torch__btn" :class="{ 'torch__btn--lit': lit }" :aria-pressed="running" @click="toggle">
          <span class="torch__icon">🔦</span>
          <span class="torch__label">{{ running ? '关闭' : '打开' }}</span>
        </button>
      </div>
    </tool-group>

    <tool-group v-if="mode === 'strobe'" :title="`频率 ${hz} Hz`">
      <van-slider :model-value="hz" :min="MIN_STROBE_HZ" :max="MAX_STROBE_HZ" :step="HZ_STEP" @update:model-value="onHzChange" />
      <p class="tool-hint torch__warn">为避免诱发光敏性癫痫等不适，频闪最高限制在 {{ MAX_STROBE_HZ }} Hz。有光敏性疾病史请不要使用，也不要对着他人的脸闪。</p>
    </tool-group>

    <p v-if="mode === 'sos'" class="tool-hint">闪出 SOS 求救信号：短短短、长长长、短短短，循环播放。</p>
    <p class="tool-hint">使用后置闪光灯，不需要相机权限；退出页面或切到后台会自动关灯。其他应用正在用相机时可能打不开。</p>
  </div>
</template>

<style lang="scss" scoped>
/* 模式按钮横排 */
.torch__modes {
  display: flex;
  gap: $space-2;
  margin-bottom: $space-3;
}

/* 大按钮居中 */
.torch__stage {
  display: flex;
  justify-content: center;
  padding: $space-4 0;
}

/* 大开关：圆形，亮时发光 */
.torch__btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 180px;
  height: 180px;
  color: var(--c-text);
  background: var(--c-bg-soft, transparent);
  border: 4px solid var(--c-border, currentcolor);
  border-radius: 50%;
  transition:
    background 0.1s,
    box-shadow 0.1s;
}

/* 灯亮时的外观 */
.torch__btn--lit {
  color: #333;
  background: #ffe066;
  box-shadow: 0 0 36px 8px #ffe066;
}

/* 按钮上的图标 */
.torch__icon {
  font-size: 56px;
}

/* 按钮上的文字 */
.torch__label {
  margin-top: $space-1;
  font-size: 16px;
}

/* 警示提示 */
.torch__warn {
  margin-top: $space-3;
  color: var(--c-warn-text);
}
</style>
