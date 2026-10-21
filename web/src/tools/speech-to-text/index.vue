<script setup lang="ts">
// 语音转文字：点一下开始录音，边说边显示（本机 zipformer 流式识别，音频不落盘不上传），再点一下停止；可复制、保存成 txt。
// 模型状态只读 stores/models.ts，缺模型只提示，下载在 AI 中心。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import BottomActions from '@/shared/BottomActions.vue'
import { useFloatPause } from '@/shared/useFloatPause'
import ModelPicker from '@/shared/ModelPicker.vue'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import { useModelGate } from '@/shared/modelGate'
import { copyText } from '@/shared/clipboard'
import { saveBlob } from '@/shared/image-io'
import { getSpeechStatus, onSpeechFinal, onSpeechPartial, speechErrorMessage, startSpeech, stopSpeech } from '@/native/speech'
import { useModelsStore } from '@/stores/models'
import {
  ASR_MODEL_ID,
  applySttFinal,
  applySttPartial,
  emptySttState,
  exportFileName,
  formatElapsed,
  isSttEmpty,
  settleStt,
  speechReadiness,
  sttPausePlan,
  transcriptText,
  type SttState,
} from './logic'

/** 本工具 id（模型选择器用） */
const TOOL_ID = 'speech-to-text'

/** 模型缺失闸门：没模型时点按钮弹「去下载」对话框 */
const { promptDownload } = useModelGate()
/** 模型 store（只读） */
const store = useModelsStore()
/** 识别文本状态 */
const state = ref<SttState>(emptySttState())
/** 原生引擎是否可用 */
const nativeAvailable = ref(false)
/** 是否已探测过引擎（探测完才提示不可用，免得闪一下） */
const probed = ref(false)
/** 正在启动（权限、加载模型） */
const starting = ref(false)
/** 正在录音 */
const listening = ref(false)
/** 已录秒数 */
const elapsed = ref(0)
/** 计时器 */
let timer: ReturnType<typeof setInterval> | null = null
/** 启动中被暂停：启动完成后立刻停止 */
let stopAfterStart = false
/** 事件取消订阅函数 */
let offs: Array<() => void> = []

/** 可用性结论 */
const readiness = computed(() => speechReadiness(!!store.get(ASR_MODEL_ID)?.installed, nativeAvailable.value))
/** 显示的整段文本 */
const text = computed(() => transcriptText(state.value))
/** 是否没有内容 */
const empty = computed(() => isSttEmpty(state.value))
/** 主按钮文案 */
const mainText = computed(() => (listening.value ? '停止' : starting.value ? '准备中…' : '开始录音'))

/** 取消事件订阅并停止计时 */
function cleanup(): void {
  offs.forEach((off) => off())
  offs = []
  if (timer) clearInterval(timer)
  timer = null
}

/** 探测引擎可用性 */
async function probe(): Promise<void> {
  nativeAvailable.value = (await getSpeechStatus()).available
  probed.value = true
}

/** 开始录音 */
async function start(): Promise<void> {
  starting.value = true
  offs = [onSpeechPartial((t) => (state.value = applySttPartial(state.value, t))), onSpeechFinal((t) => (state.value = applySttFinal(state.value, t)))]
  try {
    await startSpeech({ lang: 'zh-en' })
    listening.value = true
    elapsed.value = 0
    timer = setInterval(() => (elapsed.value += 1), 1000)
    // 启动期间被浮起或切走：启动完成后立刻收尾，不留后台会话
    if (stopAfterStart) {
      stopAfterStart = false
      void stop()
    }
  } catch (e) {
    cleanup()
    showFailToast(speechErrorMessage(e))
  } finally {
    starting.value = false
  }
}

/** 停止录音，以整段定稿收尾 */
async function stop(): Promise<void> {
  listening.value = false
  try {
    state.value = settleStt(state.value, (await stopSpeech()).text)
  } catch (e) {
    showFailToast(speechErrorMessage(e))
  } finally {
    cleanup()
  }
}

/** 主按钮：录音 / 停止 */
function onMain(): void {
  if (starting.value) return
  if (listening.value) return void stop()
  if (readiness.value === 'no-model') return void promptDownload()
  if (readiness.value !== 'ready') return void showToast('语音识别暂不可用')
  void start()
}

/** 复制全文 */
async function copy(): Promise<void> {
  if (empty.value) return
  if (await copyText(text.value)) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}

/** 保存成 txt */
async function save(): Promise<void> {
  if (empty.value) return
  try {
    const res = await saveBlob(new Blob([text.value], { type: 'text/plain;charset=utf-8' }), exportFileName(new Date()))
    showSuccessToast(res.mode === 'native' ? '已保存' : '已开始下载')
  } catch {
    showFailToast('保存失败，请重试')
  }
}

/** 清空（录音中不允许） */
function clear(): void {
  if (listening.value) return
  state.value = emptySttState()
}

// 识别不能无损暂停：录音中浮起由 BottomActions 的 main-loading 拦成 busy；
// 经导航离开前台时直接收尾（保留已识别文本），取回后需手动再点录音
useFloatPause({
  pause: () => {
    const plan = sttPausePlan(listening.value, starting.value)
    if (plan === 'stop') void stop()
    else if (plan === 'stop-after-start') stopAfterStart = true
  },
  resume: () => undefined,
})
onMounted(() => void probe())
onBeforeUnmount(() => {
  cleanup()
  if (listening.value) void stopSpeech().catch(() => {})
})
</script>

<template>
  <div class="tool-page">
    <model-missing-notice v-if="readiness === 'no-model'" />
    <van-notice-bar v-else-if="probed && readiness === 'unavailable'" wrapable :scrollable="false" left-icon="info-o">
      语音识别引擎暂不可用，请稍后再试
    </van-notice-bar>

    <tool-group :title="listening ? `录音中 ${formatElapsed(elapsed)}` : '识别结果'">
      <p v-if="empty" class="tool-hint">点下方「开始录音」，说话时文字会实时出现；中英文混说也行。</p>
      <p v-else class="stt-text">{{ text }}</p>
      <p class="tool-hint">本机识别，音频不落盘不上传；小模型识别有误差，请自己校对。</p>
    </tool-group>

    <bottom-actions :main-loading="listening" ai
      :actions="{ clear: { disabled: listening || empty }, copy: { disabled: empty }, save: { disabled: empty } }"
      main
      :main-text="mainText"
      :main-type="listening ? 'danger' : 'primary'"
      @main="onMain"
      @clear="clear"
      @copy="copy"
      @save="save"
    >
      <template #ai><model-picker :tool-id="TOOL_ID" variant="bar" /></template>
    </bottom-actions>
  </div>
</template>

<style lang="scss" scoped>
/* 识别文本：保留换行、方便长按选择 */
.stt-text {
  margin: 0 0 $space-2;
  line-height: 1.8;
  white-space: pre-wrap;
  color: var(--c-text);
  user-select: text;
}
</style>
