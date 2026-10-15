<script setup lang="ts">
// 语音输入框：van-field 的封装，右侧多一个麦克风按钮（仅本机语音识别可用时显示）。
// 点按钮开始听写，识别结果实时追加到已有文本后面；再点一次停止。文本状态逻辑见 voice-input.ts。
import { onBeforeUnmount, onDeactivated, onMounted, ref, useAttrs } from 'vue'
import { showToast } from 'vant'
import { getSpeechStatus, onSpeechFinal, onSpeechPartial, speechErrorMessage, startSpeech, stopSpeech } from '@/native/speech'
import {
  applyFinal,
  applyPartial,
  clampLength,
  dictationText,
  rebase,
  startDictation,
  type DictationState,
} from './voice-input'

/**
 * 属性
 * - modelValue：输入框文本，用 v-model 绑定
 * - 其余属性（placeholder、type、maxlength、rows、autosize、label 等）原样透传给 van-field
 *
 * @example
 * <voice-input v-model="text" type="textarea" placeholder="说点什么" maxlength="200" />
 */
const props = defineProps<{ modelValue: string }>()
/** 文本变化时触发（含语音识别写入） */
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
/** 透传属性，这里只读 maxlength 用来截断识别结果 */
const attrs = useAttrs()

/** 语音识别是否可用；不可用时不显示麦克风 */
const available = ref(false)
/** 正在启动（申请权限、加载模型），按钮显示准备态 */
const starting = ref(false)
/** 正在听写 */
const listening = ref(false)
/** 听写文本状态；非听写时为 null */
let state: DictationState | null = null
/** 事件取消订阅函数 */
let offs: Array<() => void> = []

/** 挂载时探测可用性 */
onMounted(async () => {
  available.value = (await getSpeechStatus()).available
})

/** 把当前听写文本写回 v-model */
function push(): void {
  if (state) emit('update:modelValue', clampLength(dictationText(state), attrs.maxlength as string | number | undefined))
}

/** 输入框被用户编辑：听写中以新文本为基准，免得被识别结果覆盖 */
function onInput(v: string): void {
  if (state) state = rebase(state, v)
  emit('update:modelValue', v)
}

/** 取消事件订阅 */
function unsubscribe(): void {
  offs.forEach((off) => off())
  offs = []
}

/** 开始听写 */
async function begin(): Promise<void> {
  starting.value = true
  state = startDictation(props.modelValue)
  offs = [
    onSpeechPartial((t) => {
      if (!state) return
      state = applyPartial(state, t)
      push()
    }),
    onSpeechFinal((t) => {
      if (!state) return
      state = applyFinal(state, t)
      push()
    }),
  ]
  try {
    await startSpeech({ lang: 'zh-en' })
    listening.value = true
  } catch (e) {
    unsubscribe()
    state = null
    showToast(speechErrorMessage(e))
  } finally {
    starting.value = false
  }
}

/** 结束听写：等原生冲刷完，最后一句定稿会先于返回到达 */
async function finish(): Promise<void> {
  listening.value = false
  try {
    const { text } = await stopSpeech()
    // 兜底：没收到任何定稿事件但停止时拿到了文本
    if (state && !state.finals && text) {
      state = applyFinal(state, text)
      push()
    }
  } catch (e) {
    showToast(speechErrorMessage(e))
  } finally {
    unsubscribe()
    state = null
  }
}

/** 点麦克风：没在听就开始，在听就停止 */
function toggle(): void {
  if (starting.value) return
  void (listening.value ? finish() : begin())
}

/** 离开页面或卸载时自动停止，别让麦克风一直开着 */
function stopQuietly(): void {
  if (!listening.value && !starting.value) return
  listening.value = false
  unsubscribe()
  state = null
  void stopSpeech().catch(() => undefined)
}
onBeforeUnmount(stopQuietly)
onDeactivated(stopQuietly)
</script>

<template>
  <van-field :model-value="modelValue" @update:model-value="onInput">
    <template v-if="available" #button>
      <button
        type="button"
        class="voice-mic"
        :class="{ 'is-listening': listening, 'is-starting': starting }"
        :aria-label="listening ? '停止语音输入' : '开始语音输入'"
        @click="toggle"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
          <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
        </svg>
        <span v-if="listening" class="voice-label">听写中</span>
        <span v-else-if="starting" class="voice-label">准备中</span>
      </button>
    </template>
  </van-field>
</template>

<style scoped>
.voice-mic {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: var(--van-gray-6, #969799);
  font-size: 12px;
}
.voice-mic.is-starting {
  opacity: 0.6;
}
.voice-mic.is-listening {
  color: var(--van-danger-color, #ee0a24);
  background: rgba(238, 10, 36, 0.08);
  animation: voice-pulse 1.2s ease-in-out infinite;
}
.voice-label {
  line-height: 1;
}
@keyframes voice-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
</style>
