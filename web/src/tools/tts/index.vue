<script setup lang="ts">
// 文字转语音：调系统语音引擎朗读，可调语速音调；也能合成为 wav 再分享。超长文本自动分段依次读
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { showFailToast, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { onTtsEvent, saveSpeech, speak, stopSpeaking, ttsStatus, type SavedSpeech, type TtsEvent } from '@/native/tts'
import { share } from '@/native/system'
import {
  clampFactor, createReader, currentChunk, DEFAULT_LANG, describeError, FACTOR_RANGE, INSTALL_GUIDE, nextChunk, NO_ENGINE_GUIDE, PAGE_MAX_TEXT,
  progressLabel, SAVE_CHUNK, splitText, usableLangs, type LangOption, type Reader,
} from './logic'

/** 滑块步长 */
const FACTOR_STEP = 0.1
/** wav 的 mime，分享用 */
const MIME_WAV = 'audio/wav'

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 输入文本 */
const text = ref('')
/** 语言码 */
const lang = ref(DEFAULT_LANG)
/** 语速 */
const rate = ref(1)
/** 音调 */
const pitch = ref(1)
/** 引擎是否可用 */
const available = ref(true)
/** 可选语言 */
const langs = ref<LangOption[]>(usableLangs([]))
/** 是否正在朗读 */
const speaking = ref(false)
/** 顺序朗读进度 */
const reader = ref<Reader | null>(null)
/** 保存中 */
const saving = ref(false)
/** 已保存的音频 */
const saved = ref<SavedSpeech[]>([])
/** 页面上展示的指引（语音数据缺失等） */
const guide = ref('')
/** 当前朗读任务 id；null 表示没有（或正在等原生返回） */
let currentId: string | null = null
/** 正在等 speak 返回 id 期间提前到达的事件 */
let early: TtsEvent[] = []
/** 是否正在等 speak 返回 */
let starting = false
/** 取消订阅 */
let off: (() => void) | undefined

/** 进度文字，如 `2 / 5` */
const progress = computed(() => (reader.value ? progressLabel(reader.value) : ''))
/** 能否朗读 */
const canSpeak = computed(() => text.value.trim() !== '' && available.value)

/** 收尾：回到待机 */
function finish(): void {
  speaking.value = false
  reader.value = null
  currentId = null
}

/** 读当前段；没有可读的就收尾 */
async function speakCurrent(): Promise<void> {
  const r = reader.value
  const chunk = r ? currentChunk(r) : null
  if (!chunk) {
    finish()
    return
  }
  starting = true
  currentId = null
  early = []
  try {
    const id = await speak({ text: chunk, lang: lang.value, rate: clampFactor(rate.value), pitch: clampFactor(pitch.value) })
    currentId = id
    // 原生已读完 / 被打断但响应还没到：补处理
    for (const e of early) handleEvent(e)
  } catch (e) {
    finish()
    guide.value = describeError(e)
    showFailToast('朗读失败')
  } finally {
    starting = false
    early = []
  }
}

/** 处理朗读事件：读完接着读下一段，被打断就结束 */
function handleEvent(e: TtsEvent): void {
  if (starting && currentId === null) {
    early.push(e)
    return
  }
  if (e.id !== currentId) return
  if (e.type === 'done' && reader.value) {
    reader.value = nextChunk(reader.value)
    void speakCurrent()
    return
  }
  if (e.error) showFailToast('朗读被中断')
  finish()
}

/** 开始朗读 */
async function onSpeak(): Promise<void> {
  const r = createReader(text.value)
  if (!currentChunk(r)) {
    showToast('先输入要朗读的文字')
    return
  }
  guide.value = ''
  reader.value = r
  speaking.value = true
  currentId = null
  await speakCurrent()
}

/** 停止朗读 */
async function onStop(): Promise<void> {
  const wasSpeaking = speaking.value
  finish()
  if (wasSpeaking) {
    try {
      await stopSpeaking()
    } catch {
      // 停止失败无需打扰用户
    }
  }
}

/** 合成为 wav：长文本分成多个文件 */
async function onSave(): Promise<void> {
  const parts = splitText(text.value, SAVE_CHUNK)
  if (parts.length === 0) {
    showToast('先输入要朗读的文字')
    return
  }
  guide.value = ''
  saving.value = true
  const files: SavedSpeech[] = []
  try {
    for (const part of parts) {
      files.push(await saveSpeech({ text: part, lang: lang.value, rate: clampFactor(rate.value), pitch: clampFactor(pitch.value) }))
    }
    saved.value = files
    showToast(files.length > 1 ? `已生成 ${files.length} 段音频` : '已生成音频')
  } catch (e) {
    saved.value = files
    guide.value = describeError(e)
    showFailToast('保存失败')
  } finally {
    saving.value = false
  }
}

/** 分享一个音频文件 */
async function onShare(f: SavedSpeech): Promise<void> {
  try {
    if (!(await share({ path: f.path, mime: MIME_WAV, title: f.name }))) showToast('没能打开分享面板')
  } catch (e) {
    showFailToast((e as { message?: string }).message || '分享失败')
  }
}

onMounted(async () => {
  off = onTtsEvent(handleEvent)
  const s = await ttsStatus().catch(() => ({ available: false, langs: [] as string[] }))
  available.value = s.available
  langs.value = usableLangs(s.langs)
  if (!s.available) guide.value = NO_ENGINE_GUIDE
  else if (s.langs.length > 0 && !langs.value.some((o) => o.code === lang.value)) {
    guide.value = INSTALL_GUIDE
    if (langs.value[0]) lang.value = langs.value[0].code
  }
})
onBeforeUnmount(() => {
  off?.()
  if (speaking.value) void stopSpeaking().catch(() => undefined)
})
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="guide" wrapable :scrollable="false" left-icon="warning-o">{{ guide }}</van-notice-bar>

    <tool-group>
      <van-field v-model="text" type="textarea" rows="5" autosize placeholder="输入要朗读的文字" :maxlength="PAGE_MAX_TEXT" show-word-limit />
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <van-cell title="语言" center>
          <template #value>
            <select v-model="lang" class="tts-select" aria-label="语言">
              <option v-for="o in langs" :key="o.code" :value="o.code">{{ o.name }}</option>
            </select>
          </template>
        </van-cell>
        <van-cell :title="`语速 ${rate}×`" center>
          <template #value>
            <van-slider v-model="rate" :min="FACTOR_RANGE.min" :max="FACTOR_RANGE.max" :step="FACTOR_STEP" class="tts-slider" />
          </template>
        </van-cell>
        <van-cell :title="`音调 ${pitch}×`" center>
          <template #value>
            <van-slider v-model="pitch" :min="FACTOR_RANGE.min" :max="FACTOR_RANGE.max" :step="FACTOR_STEP" class="tts-slider" />
          </template>
        </van-cell>
      </van-cell-group>
    </tool-group>

    <tool-group v-if="saved.length" title="已生成的音频">
      <van-cell-group :border="false">
        <van-cell v-for="f in saved" :key="f.path" :title="f.name" center>
          <template #right-icon>
            <van-button size="small" plain type="primary" @click="onShare(f)">分享</van-button>
          </template>
        </van-cell>
      </van-cell-group>
    </tool-group>
    <p class="tool-hint">用系统自带的语音引擎，不联网。保存为音频只在 Arkli 应用里可用，长文本会分成几段文件。</p>

    <!-- 底部动作栏：保存为音频，主按钮朗读（朗读中变成停止） -->
    <bottom-actions :actions="{ save: { disabled: !hosted || !canSpeak || saving, text: '存音频' } }" main :main-text="speaking ? `停止${progress ? `（${progress}）` : ''}` : '朗读'" :main-type="speaking ? 'danger' : 'primary'" :disabled="{ main: !speaking && !canSpeak }" @main="speaking ? onStop() : onSpeak()" @save="onSave" />
  </div>
</template>

<style lang="scss" scoped>
/* 语言下拉，贴合主题 */
.tts-select {
  padding: 4px 8px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-text);
  font-size: 15px;
}

/* 滑块撑满右侧 */
.tts-slider {
  width: 100%;
  margin: $space-2 0;
}
</style>
