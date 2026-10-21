<script setup lang="ts">
// 番茄时钟：专注 / 短休 / 长休，倒计时按绝对时间算；容器内用原生闹钟，退到后台也会提醒
import BottomActions from '@/shared/BottomActions.vue'
import { useFloatPause } from '@/shared/useFloatPause'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { showFailToast, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { cancelAlarm, setAlarm } from '@/native/reminder'
import { keepAwake, requestPermission } from '@/native/system'
import { createWakeLock } from '@/shared/wakelock'
import {
  advance, alarmCopy, ALARM_ID, bumpToday, doneRounds, EVERY_RANGE, FOCUS_RANGE, formatClock, initialState, loadSettings, loadState, loadToday,
  LONG_RANGE, normalizeSettings, pause, PHASE_LABEL, phaseDurationMs, progressOf, remainingAt, resetAll, resetPhase, saveSettings,
  saveState, SHORT_RANGE, skip, start, wantsAwake, type Phase, type Settings, type TimerState,
} from './logic'

/** 页面刷新倒计时的间隔（毫秒）；只用来重绘，剩余时间始终由时间戳算出 */
const TICK_MS = 250
/** 进度环半径 */
const RING_R = 88
/** 进度环周长 */
const RING_LEN = 2 * Math.PI * RING_R
/** 无宿主时的提示 */
const TIP_NO_HOST = '当前是浏览器环境，只有页面内倒计时，退出页面后不会提醒。'
/** 阶段对应的主题色变量 */
const PHASE_COLOR: Record<Phase, string> = { focus: 'var(--c-primary)', short: 'var(--c-ok)', long: 'var(--c-warn-text)' }

/** 取本地存储，不可用时为 null */
function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
const kv = storage()

/** 是否在 Arkli 容器内 */
const hosted = isNativeAvailable()
/** 时长设置 */
const settings = ref<Settings>(loadSettings(kv))
/** 计时状态：进来时尝试恢复上次的（闹钟在退出页面后仍会响） */
const st = ref<TimerState>(loadState(kv) ?? initialState(settings.value))
/** 当前时间戳，定时刷新用于重绘 */
const now = ref(Date.now())
/** 今日完成的专注数 */
const today = ref(loadToday(kv, Date.now()))
/** 是否保持屏幕常亮 */
const keepOn = ref(false)
/** 本次页面是否已问过通知权限 */
let asked = false
/** 定时器 */
let timer: ReturnType<typeof setInterval> | undefined
/** 网页常亮控制（原生不可用时的兜底） */
const wake = createWakeLock()
/** 当前是否用原生常亮 */
let nativeAwake = false

/** 当前阶段中文名 */
const phaseLabel = computed(() => PHASE_LABEL[st.value.phase])
/** 倒计时文字 */
const clock = computed(() => formatClock(remainingAt(st.value, now.value)))
/** 进度环已走过的长度 */
const dash = computed(() => RING_LEN * (1 - progressOf(st.value, settings.value, now.value)))
/** 阶段主题色 */
const color = computed(() => PHASE_COLOR[st.value.phase])
/** 设置是否可改：进行中时锁住 */
const locked = computed(() => st.value.status === 'running')
/** 本循环已完成的专注数 */
const done = computed(() => doneRounds(st.value))
/** 当前阶段一轮之内的轮次点 */
const dots = computed(() => Array.from({ length: settings.value.longEvery }, (_, i) => i + 1))

/** 状态变化就落盘 */
watch(st, (v) => saveState(kv, v), { deep: true })

/** 刷新时间并处理到点：计数、换阶段 */
function tick(): void {
  now.value = Date.now()
  const r = advance(st.value, settings.value, now.value)
  if (!r) return
  st.value = r.state
  if (r.focusDone) today.value = bumpToday(kv, now.value)
  const c = alarmCopy(r.finished)
  showToast(`${c.title}：${c.text}`)
}

/** 首次开始前确认通知权限，被拒给一次提示，不阻止计时 */
async function ensureNotifyPermission(): Promise<void> {
  if (!hosted || asked) return
  asked = true
  try {
    const r = await requestPermission('notifications')
    if (!r.granted && r.reason !== 'not_declared') showToast('没有通知权限，到点不会弹出提醒，可在系统设置里打开')
  } catch {
    // 查权限失败不影响计时
  }
}

/** 为当前进行中的阶段设置结束提醒 */
async function armAlarm(s: TimerState): Promise<void> {
  if (!hosted || s.endAt === null) return
  const c = alarmCopy(s.phase)
  try {
    await setAlarm({ id: ALARM_ID, atEpochMs: s.endAt, title: c.title, text: c.text })
  } catch {
    showFailToast('提醒设置失败，退出页面后可能不会提醒')
  }
}

/** 取消结束提醒，失败静默 */
async function disarmAlarm(): Promise<void> {
  if (!hosted) return
  try {
    await cancelAlarm(ALARM_ID)
  } catch {
    // 取消失败无需打扰用户
  }
}

/** 开始或继续 */
async function onStart(): Promise<void> {
  await ensureNotifyPermission()
  st.value = start(st.value, Date.now())
  now.value = Date.now()
  await armAlarm(st.value)
}

/** 暂停：取消提醒，继续时按剩余时间重设 */
async function onPause(): Promise<void> {
  st.value = pause(st.value, Date.now())
  await disarmAlarm()
}

/** 重置当前阶段 */
async function onResetPhase(): Promise<void> {
  st.value = resetPhase(st.value, settings.value)
  await disarmAlarm()
}

/** 全部重置回第 1 轮专注 */
async function onResetAll(): Promise<void> {
  st.value = resetAll(settings.value)
  await disarmAlarm()
}

/** 跳到下一阶段 */
async function onSkip(): Promise<void> {
  st.value = skip(st.value, settings.value)
  await disarmAlarm()
}

/** 改时长：规范化后落盘，待开始 / 暂停时让当前阶段按新时长重来 */
function onSettingsChange(patch: Partial<Settings>): void {
  settings.value = normalizeSettings({ ...settings.value, ...patch })
  saveSettings(kv, settings.value)
  if (st.value.status === 'idle') st.value = { ...st.value, remainingMs: phaseDurationMs(settings.value, st.value.phase) }
}

/** 常亮：容器内用原生，失败或浏览器里退回网页 wakeLock */
async function applyAwake(want: boolean): Promise<void> {
  if (want) {
    try {
      await keepAwake(true)
      nativeAwake = true
      return
    } catch {
      nativeAwake = false
    }
    if (!(await wake.acquire())) showToast('这台设备不支持常亮，请在系统设置里调长息屏时间')
    return
  }
  if (nativeAwake) {
    nativeAwake = false
    try {
      await keepAwake(false)
    } catch {
      // 释放失败忽略，退出页面时系统会清掉
    }
  }
  await wake.release()
}

/** 只在进行中且开关打开时常亮 */
watch([keepOn, () => st.value.status], ([on, status]) => void applyAwake(wantsAwake(on, status)))

/** 页面回到前台立刻刷新，别等下一次定时 */
function onVisible(): void {
  if (document.visibilityState === 'visible') tick()
}

/** 开启刷新：先立即对一次时间（处理期间到点），再起定时与回前台监听；重复调用不会叠加定时器 */
function startLoop(): void {
  stopLoop()
  tick()
  timer = setInterval(tick, TICK_MS)
  document.addEventListener('visibilitychange', onVisible)
}

/** 停掉刷新与回前台监听 */
function stopLoop(): void {
  clearInterval(timer)
  timer = undefined
  document.removeEventListener('visibilitychange', onVisible)
}

/**
 * 浮起 / 离开前台：停刷新、放掉常亮。
 * 计时本身按结束时间戳算，浮起期间不会多算少算；原生闹钟不取消（与“退出页面后到点仍会提醒”一致），
 * 浮起期间到点仍会弹通知；回来时 resume 里的 tick 会补做换阶段与计数。
 */
useFloatPause({
  pause: () => {
    stopLoop()
    void applyAwake(false)
  },
  resume: () => {
    startLoop()
    void applyAwake(wantsAwake(keepOn.value, st.value.status))
  },
})

onMounted(startLoop)
onBeforeUnmount(() => {
  stopLoop()
  // 不取消闹钟：退出页面后到点仍会提醒；常亮要还回去
  void applyAwake(false)
})
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrapable :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>

    <tool-group class="pm-clock">
      <van-tag round :color="color" size="large">{{ phaseLabel }}</van-tag>
      <div class="pm-ring">
        <svg viewBox="0 0 200 200" class="pm-ring__svg" aria-hidden="true">
          <circle cx="100" cy="100" :r="RING_R" class="pm-ring__bg" />
          <circle
            cx="100"
            cy="100"
            :r="RING_R"
            class="pm-ring__fg"
            :style="{ stroke: color, strokeDasharray: RING_LEN, strokeDashoffset: dash }"
          />
        </svg>
        <span class="pm-time" role="timer">{{ clock }}</span>
      </div>
      <div class="pm-dots" aria-label="本轮进度">
        <span v-for="i in dots" :key="i" class="pm-dot" :class="{ 'pm-dot--on': i <= done }" />
      </div>
      <div class="pm-actions">
        <van-button plain round @click="onResetPhase">重来本阶段</van-button>
        <van-button plain round @click="onSkip">跳过</van-button>
      </div>
    </tool-group>

    <tool-group :title="`今天已完成 ${today} 个专注`">
      <van-cell-group :border="false">
        <van-cell title="专注（分钟）" center>
          <template #value>
            <van-stepper :model-value="settings.focusMin" :min="FOCUS_RANGE.min" :max="FOCUS_RANGE.max" integer :disabled="locked" @change="(v: number) => onSettingsChange({ focusMin: v })" />
          </template>
        </van-cell>
        <van-cell title="短休（分钟）" center>
          <template #value>
            <van-stepper :model-value="settings.shortMin" :min="SHORT_RANGE.min" :max="SHORT_RANGE.max" integer :disabled="locked" @change="(v: number) => onSettingsChange({ shortMin: v })" />
          </template>
        </van-cell>
        <van-cell title="长休（分钟）" center>
          <template #value>
            <van-stepper :model-value="settings.longMin" :min="LONG_RANGE.min" :max="LONG_RANGE.max" integer :disabled="locked" @change="(v: number) => onSettingsChange({ longMin: v })" />
          </template>
        </van-cell>
        <van-cell title="几轮后长休" center>
          <template #value>
            <van-stepper :model-value="settings.longEvery" :min="EVERY_RANGE.min" :max="EVERY_RANGE.max" integer :disabled="locked" @change="(v: number) => onSettingsChange({ longEvery: v })" />
          </template>
        </van-cell>
        <van-cell title="计时时屏幕常亮" center>
          <template #value>
            <van-switch v-model="keepOn" size="22" />
          </template>
        </van-cell>
      </van-cell-group>
      <van-button class="pm-reset" plain block type="danger" size="small" @click="onResetAll">全部重置</van-button>
    </tool-group>
    <p class="tool-hint">每个阶段结束时用系统闹钟提醒，退到后台或锁屏也会响。设备重启后提醒会失效。</p>

    <!-- 底部动作栏：主按钮开始 / 继续 / 暂停 -->
    <bottom-actions :main-loading="st.status === 'running'" main :main-text="st.status === 'running' ? '暂停' : st.status === 'paused' ? '继续' : '开始'" :main-type="st.status === 'running' ? 'warning' : 'primary'" @main="st.status === 'running' ? onPause() : onStart()" />
  </div>
</template>

<style lang="scss" scoped>
/* 计时卡片：内容居中 */
.pm-clock {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-3;
}

/* 进度环容器，数字叠在环中央 */
.pm-ring {
  position: relative;
  width: 220px;
  height: 220px;
}

/* 环从 12 点方向开始 */
.pm-ring__svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

/* 环底色 */
.pm-ring__bg {
  fill: none;
  stroke: var(--c-border);
  stroke-width: 10;
}

/* 已走过的部分 */
.pm-ring__fg {
  fill: none;
  stroke-width: 10;
  stroke-linecap: round;
}

/* 倒计时数字 */
.pm-time {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 48px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--c-text);
}

/* 轮次小圆点 */
.pm-dots {
  display: flex;
  gap: $space-2;
}

.pm-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--c-border);

  &--on {
    background: var(--c-primary);
  }
}

/* 操作按钮一排 */
.pm-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: $space-2;
}

/* 全部重置与上方留距 */
.pm-reset {
  margin-top: $space-3;
}
</style>
