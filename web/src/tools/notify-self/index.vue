<script setup lang="ts">
// 通知自己：给自己发一条通知，可立即、N 分钟后或指定时间；待触发的提醒可在列表里取消
import BottomActions from '@/shared/BottomActions.vue'
import { useFloatPause } from '@/shared/useFloatPause'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { cancelAlarm, listAlarms, setAlarm, showNotification, type AlarmItem } from '@/native/reminder'
import { requestPermission } from '@/native/system'
import {
  buildPlan, DELAY_PRESETS, formatAt, formatCountdown, isOwnAlarm, makeAlarmId, MAX_TEXT, MAX_TITLE, toLocalDateTime, MS_PER_MIN, type Mode,
} from './logic'

/** 刷新倒计时的间隔（毫秒） */
const TICK_MS = 30_000
/** 指定时间默认值：一小时后 */
const DEFAULT_AT_OFFSET_MS = 60 * MS_PER_MIN
/** 无宿主时的提示 */
const TIP_NO_HOST = '通知和闹钟只能在 Arkli 应用里使用，浏览器里没法发。'

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 提醒方式选项 */
const MODE_OPTIONS: readonly CellOption[] = [
  { value: 'now', label: '立即' },
  { value: 'delay', label: 'N 分钟后' },
  { value: 'at', label: '指定时间' },
]
/** 提醒方式 */
const mode = ref<Mode>('delay')
/** 标题 */
const title = ref('')
/** 正文 */
const text = ref('')
/** 几分钟后 */
const delayMin = ref<string | number>(10)
/** 指定时间（datetime-local 的值） */
const atText = ref(toLocalDateTime(Date.now() + DEFAULT_AT_OFFSET_MS))
/** 待触发的提醒 */
const items = ref<AlarmItem[]>([])
/** 当前时间，用于倒计时展示 */
const now = ref(Date.now())
/** 提交中 */
const busy = ref(false)
/** 定时器 */
let timer: ReturnType<typeof setInterval> | undefined

/** 提交按钮文字 */
const submitText = computed(() => (mode.value === 'now' ? '立即通知' : '设置提醒'))

/** 刷新待触发列表；只显示本页创建的 */
async function refresh(): Promise<void> {
  if (!hosted) return
  try {
    items.value = (await listAlarms()).filter((a) => isOwnAlarm(a.id))
  } catch {
    items.value = []
  }
}

/** 确认通知权限；被拒返回 false 并提示 */
async function ensurePermission(): Promise<boolean> {
  try {
    const r = await requestPermission('notifications')
    if (r.granted || r.reason === 'not_declared') return true
  } catch {
    // 查权限失败按未授权处理
  }
  showFailToast('需要通知权限，请在系统设置里打开')
  return false
}

/** 提交：校验 -> 申请权限 -> 立即发或设闹钟 */
async function submit(): Promise<void> {
  const r = buildPlan({ mode: mode.value, title: title.value, text: text.value, delayMin: delayMin.value, atText: atText.value }, Date.now())
  if (!r.ok) {
    showToast(r.error)
    return
  }
  busy.value = true
  try {
    if (!(await ensurePermission())) return
    const { plan } = r
    if (plan.kind === 'now') {
      await showNotification({ title: plan.title, text: plan.text })
      showSuccessToast('已发出')
    } else {
      await setAlarm({ id: makeAlarmId(Date.now()), atEpochMs: plan.atEpochMs!, title: plan.title, text: plan.text })
      showSuccessToast(`将在${formatAt(plan.atEpochMs!, Date.now())}提醒`)
      await refresh()
    }
  } catch (e) {
    showFailToast((e as { message?: string }).message || '操作失败')
  } finally {
    busy.value = false
  }
}

/** 取消一条待触发的提醒 */
async function remove(id: string): Promise<void> {
  try {
    await cancelAlarm(id)
  } catch (e) {
    showFailToast((e as { message?: string }).message || '取消失败')
  }
  await refresh()
}

/** 开启定时刷新（先清旧的，不会叠加）；倒计时按时间戳算，刷新只负责重绘与同步列表 */
function startLoop(): void {
  stopLoop()
  timer = setInterval(() => {
    now.value = Date.now()
    void refresh()
  }, TICK_MS)
}

/** 停掉定时刷新 */
function stopLoop(): void {
  clearInterval(timer)
  timer = undefined
}

/**
 * 浮起 / 离开前台：停轮询。已设的系统闹钟不取消（到点仍会提醒，与退出页面一致）；
 * 回来时立刻刷新一次时间与列表（期间到点的提醒会从列表消失），再重开轮询。
 */
useFloatPause({
  pause: stopLoop,
  resume: () => {
    now.value = Date.now()
    void refresh()
    startLoop()
  },
})

onMounted(() => {
  void refresh()
  startLoop()
})
onBeforeUnmount(stopLoop)
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrapable :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>

    <tool-group>
      <van-field v-model="title" label="标题" placeholder="提醒我做什么" :maxlength="MAX_TITLE" />
      <van-field v-model="text" label="内容" type="textarea" rows="2" autosize placeholder="可选，补充说明" :maxlength="MAX_TEXT" />
    </tool-group>

    <tool-group>
      <cell-picker v-model="mode" title="什么时候提醒" :options="MODE_OPTIONS" />

      <div v-if="mode === 'delay'" class="ns-row">
        <van-button v-for="n in DELAY_PRESETS" :key="n" size="small" :type="Number(delayMin) === n ? 'primary' : 'default'" @click="delayMin = n">
          {{ n }} 分钟
        </van-button>
        <van-stepper v-model="delayMin" :min="1" :max="1440" integer input-width="56px" />
      </div>
      <div v-else-if="mode === 'at'" class="ns-row">
        <input v-model="atText" class="ns-datetime" type="datetime-local" aria-label="提醒时间" />
      </div>
    </tool-group>

    <tool-group title="待触发的提醒">
      <van-empty v-if="items.length === 0" image-size="64" description="暂无" />
      <van-cell-group v-else :border="false">
        <van-cell v-for="a in items" :key="a.id" :title="a.title" :label="`${formatAt(a.atEpochMs, now)}（还有 ${formatCountdown(a.atEpochMs - now)}）`" center>
          <template #right-icon>
            <van-button size="small" plain type="danger" @click="remove(a.id)">取消</van-button>
          </template>
        </van-cell>
      </van-cell-group>
    </tool-group>
    <p class="tool-hint">到点由系统闹钟唤起，App 退到后台也会提醒。设备重启后未触发的提醒会失效。</p>

    <!-- 底部动作栏：主按钮提醒 -->
    <bottom-actions :main-loading="busy" main :main-text="busy ? '提交中' : submitText" :disabled="{ main: busy || !hosted }" @main="submit" />
  </div>
</template>

<style lang="scss" scoped>
/* 时间选项一行，可换行 */
.ns-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-2;
  margin-top: $space-3;
}

/* 原生时间选择器，贴合主题 */
.ns-datetime {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: var(--c-surface);
  color: var(--c-text);
  font-size: 16px;
}
</style>
