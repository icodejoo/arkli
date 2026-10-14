<script setup lang="ts">
// 通知自己：给自己发一条通知，可立即、N 分钟后或指定时间；待触发的提醒可在列表里取消
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

onMounted(() => {
  void refresh()
  timer = setInterval(() => {
    now.value = Date.now()
    void refresh()
  }, TICK_MS)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrap-able :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>

    <div class="tool-card">
      <van-field v-model="title" label="标题" placeholder="提醒我做什么" :maxlength="MAX_TITLE" />
      <van-field v-model="text" label="内容" type="textarea" rows="2" autosize placeholder="可选，补充说明" :maxlength="MAX_TEXT" />
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">什么时候提醒</h3>
      <van-radio-group v-model="mode" direction="horizontal">
        <van-radio name="now">立即</van-radio>
        <van-radio name="delay">N 分钟后</van-radio>
        <van-radio name="at">指定时间</van-radio>
      </van-radio-group>

      <div v-if="mode === 'delay'" class="ns-row">
        <van-button v-for="n in DELAY_PRESETS" :key="n" size="small" :type="Number(delayMin) === n ? 'primary' : 'default'" @click="delayMin = n">
          {{ n }} 分钟
        </van-button>
        <van-stepper v-model="delayMin" :min="1" :max="1440" integer input-width="56px" />
      </div>
      <div v-else-if="mode === 'at'" class="ns-row">
        <input v-model="atText" class="ns-datetime" type="datetime-local" aria-label="提醒时间" />
      </div>
    </div>

    <van-button type="primary" block round :loading="busy" :disabled="!hosted" @click="submit">{{ submitText }}</van-button>

    <div class="tool-card">
      <h3 class="tool-card__title">待触发的提醒</h3>
      <van-empty v-if="items.length === 0" image-size="64" description="暂无" />
      <van-cell-group v-else :border="false">
        <van-cell v-for="a in items" :key="a.id" :title="a.title" :label="`${formatAt(a.atEpochMs, now)}（还有 ${formatCountdown(a.atEpochMs - now)}）`" center>
          <template #right-icon>
            <van-button size="small" plain type="danger" @click="remove(a.id)">取消</van-button>
          </template>
        </van-cell>
      </van-cell-group>
    </div>
    <p class="tool-hint">到点由系统闹钟唤起，App 退到后台也会提醒。设备重启后未触发的提醒会失效。</p>
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
