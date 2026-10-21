<script setup lang="ts">
// AI 写作助手：本地 Qwen（prompt 预设）做起名、起标题、润色、扩写、缩写。
// 模型状态只读（目录与 store），下载等都在 AI 中心；生成可随时取消，取消后能再次生成。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import BottomActions from '@/shared/BottomActions.vue'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import ModelPicker from '@/shared/ModelPicker.vue'
import CellPicker from '@/shared/CellPicker.vue'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { copyText } from '@/shared/clipboard'
import { AiNotReadyError, aiInvoke, isAiCancelled } from '@/native/ai'
import { AI_METHODS } from '@/native/aiMethods'
import { useAiCatalog } from '@/native/useAiCatalog'
import {
  MODE_NOTE,
  MSG_TRUNCATED,
  NAME_KINDS,
  STYLE_INPUT_MAX,
  WRITER_MODES,
  WRITER_PRESET,
  buildRequest,
  inputLimit,
  isListMode,
  parseCandidates,
  validateInput,
  type NameKind,
  type WriterMode,
} from './logic'

/** 本工具 id（与 registry 一致） */
const TOOL_ID = 'ai-writer'
/** 文本生成用的提供者 */
const PROVIDER_QWEN = 'local-qwen'
/** 模型未就绪提示 */
const MSG_NOT_READY = '模型还没就绪，请先下载'
/** 各模式输入框占位 */
const PLACEHOLDERS: Record<WriterMode, string> = {
  name: '说说用途或要求，如：一家卖手冲咖啡的小店',
  title: '粘贴要拟标题的内容',
  polish: '粘贴要润色的文字',
  expand: '粘贴要扩写的文字',
  shrink: '粘贴要缩写的文字',
}

/** 本工具的持久缓存 */
const store = createToolStorage(TOOL_ID)
/** 本工具的 AI 目录 */
const catalog = useAiCatalog(TOOL_ID)

/** 当前模式 */
const mode = usePersistedRef<WriterMode>(store, 'mode', 'name', (v) => WRITER_MODES.some((m) => m.key === v))
/** 起名类别 */
const nameKind = usePersistedRef<NameKind>(store, 'nameKind', 'person', (v) => NAME_KINDS.some((k) => k.key === v))
/** 起名类别选项 */
const NAME_KIND_OPTIONS = NAME_KINDS.map((k) => ({ value: k.key, label: k.label }))
/** 风格 */
const style = ref('')
/** 输入 */
const input = ref('')
/** 候选（起名、起标题） */
const candidates = ref<string[]>([])
/** 文本结果（润色、扩写、缩写） */
const output = ref('')
/** 是否正在生成 */
const busy = ref(false)
/** 取消控制器 */
let abort: AbortController | null = null
/** 第几次执行：取消后界面立刻放开，旧任务晚到的收尾不能冲掉新任务的状态 */
let runSeq = 0

/** 大模型是否就绪 */
const qwenReady = computed(() => catalog.items.value.find((i) => i.providerId === PROVIDER_QWEN)?.status === 'ready')
/** 探测完且没就绪才提示缺模型 */
const missing = computed(() => catalog.ready.value && !qwenReady.value)
/** 当前模式输入上限 */
const limit = computed(() => inputLimit(mode.value))
/** 是否有可复制的结果 */
const hasResult = computed(() => (isListMode(mode.value) ? candidates.value.length > 0 : !!output.value.trim()))
/** 主按钮文案 */
const runText = computed(() => (busy.value ? '取消' : '生成'))

/** 切模式时清掉上一个模式的结果 */
watch(mode, () => {
  candidates.value = []
  output.value = ''
})

/** 点主按钮：忙时取消，否则生成 */
async function onRun(): Promise<void> {
  if (busy.value) {
    abort?.abort()
    busy.value = false
    return
  }
  const params = { mode: mode.value, input: input.value, nameKind: nameKind.value, style: style.value }
  const issue = validateInput(params)
  if (issue) return void showToast(issue)
  if (missing.value || !qwenReady.value) return void showToast(MSG_NOT_READY)
  const req = buildRequest(params)
  if (req.truncated) showToast(MSG_TRUNCATED(req.inputMax))
  abort = new AbortController()
  busy.value = true
  const seq = ++runSeq
  try {
    const r = await aiInvoke(
      'prompt',
      { text: req.text },
      { provider: PROVIDER_QWEN, entry: AI_METHODS.run, options: { preset: WRITER_PRESET, system: req.system, temperature: req.temperature }, signal: abort.signal },
    )
    if (seq !== runSeq) return
    const text = r.text ?? ''
    if (isListMode(mode.value)) candidates.value = parseCandidates(text)
    else output.value = text.trim()
    if (!text.trim()) showToast('模型没写出内容，换个说法再试')
  } catch (e) {
    if (isAiCancelled(e)) return
    if (e instanceof AiNotReadyError) {
      showToast(MSG_NOT_READY)
      void catalog.refresh()
    } else {
      showFailToast((e as { message?: string } | null)?.message || '出错了，请重试')
    }
  } finally {
    if (seq === runSeq) {
      busy.value = false
      abort = null
    }
  }
}

/** 复制一条候选 */
async function copyOne(s: string): Promise<void> {
  showToast((await copyText(s)) ? '已复制' : '复制失败，请手动长按选择')
}

/** 复制全部结果 */
async function copyAll(): Promise<void> {
  const t = isListMode(mode.value) ? candidates.value.join('\n') : output.value
  if (!t.trim()) return
  if (await copyText(t)) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}

onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="mode" type="card" :swipeable="false">
      <van-tab v-for="m in WRITER_MODES" :key="m.key" :title="m.label" :name="m.key" />
    </van-tabs>

    <model-missing-notice v-if="missing" />

    <tool-group :title="mode === 'name' ? '起名要求' : '原文'">
      <cell-picker v-if="mode === 'name'" :model-value="nameKind" title="类别" :options="NAME_KIND_OPTIONS" @update:model-value="nameKind = $event as NameKind" />
      <van-field v-if="mode === 'name'" v-model="style" label="风格" placeholder="可选，如：文艺、可爱、国风" :maxlength="STYLE_INPUT_MAX" clearable />
      <van-field v-model="input" type="textarea" rows="4" autosize :maxlength="limit" show-word-limit :placeholder="PLACEHOLDERS[mode]" />
      <p class="tool-hint">{{ MODE_NOTE }}。</p>
    </tool-group>

    <tool-group v-if="isListMode(mode) && candidates.length" title="候选（点一下复制）">
      <van-cell v-for="(c, i) in candidates" :key="i" :title="c" clickable @click="copyOne(c)" />
    </tool-group>
    <tool-group v-else-if="!isListMode(mode) && output" title="结果">
      <van-field v-model="output" type="textarea" rows="4" autosize />
    </tool-group>

    <bottom-actions :main-loading="busy" :actions="{ copy: { disabled: !hasResult } }" ai main :main-text="runText" :main-type="busy ? 'danger' : 'primary'" @main="onRun" @copy="copyAll">
      <template #ai>
        <model-picker :tool-id="TOOL_ID" variant="bar" />
      </template>
    </bottom-actions>
  </div>
</template>
