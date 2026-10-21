<script setup lang="ts">
// 随机点名：粘贴名单，抽 1 人，可选不重复，Three.js 3D 滚筒舞台表演
import BottomActions from '@/shared/BottomActions.vue'
import { useFloatPause } from '@/shared/useFloatPause'
import ModelPicker from '@/shared/ModelPicker.vue'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { showToast } from 'vant'
import { useRoute } from 'vue-router'
import { TOOL_SETTING_ROUTE } from '@/router'
import { pickFile } from '@/shared/file-pick'
import { EDIT_BASIC, pickImages, type PickedImage } from '@/shared/image-io'
import { shootPhoto } from '@/shared/shootPhoto'
import { aiOcr, AiNotReadyError, isAiCancelled } from '@/native/ai'
import { useAiCatalog } from '@/native/useAiCatalog'
import { aiErrorText, handleNotReady, resolveImagePath } from '@/tools/_ai/aiImage'
import { useModelGate } from '@/shared/modelGate'
import { useModelsStore } from '@/stores/models'
import { ASR_MODEL_ID } from '../speech-to-text/logic'
import { groupLines, linesToText } from '../ocr/logic'
import { getSpeechStatus, onSpeechFinal, speechErrorMessage, startSpeech, stopSpeech } from '@/native/speech'
import { prefersReducedMotion } from '@/shared/motion'
import { createSettleTimer } from '../coin-flip/logic'
import { createToolStorage } from '@/shared/toolStorage'
import { useRollCallSettings } from './settings'
import { calcMainButton, createDebouncer, drawNames, loadNames, needsPreviewRebuild, parseNames, PREVIEW_DEBOUNCE_MS, previewKey, saveNames, TOOL_NS } from './logic'
import type { RollCallStage3D } from './stage3d'

/** 动画安全超时与兜底时长（毫秒） */
const ANIM_FALLBACK_MS = 200

/** 本工具 id（与 registry 一致） */
const TOOL_ID = 'roll-call'
/** 导入文本时允许的类型 */
const TEXT_MIME = 'text/*'
/** 无宿主时 input 兜底的扩展名 */
const TEXT_ACCEPT = 'text/*,.txt,.csv,.md'
/** 减少动画提示文案 */
const TOAST_MOTION_REDUCED = '系统开启了减少动画，已直接显示结果'
/** 设备不支持 WebGL 提示文案 */
const TOAST_NO_WEBGL = '设备不支持 3D 动画，已直接显示结果'
/** 主按钮危险色（手动模式的“停止”） */
const DANGER_COLOR = 'var(--van-danger-color)'

/** 本工具的 AI 目录：模型状态只读（下载等都在 AI 中心） */
const catalog = useAiCatalog(TOOL_ID)
/** 目录是否已探测过 */
const catalogReady = catalog.ready
/** 文字识别模型是否就绪 */
const modelReady = computed(() => catalog.current.value?.status === 'ready')
/** 模型缺失闸门：未就绪时点按钮弹「去下载」对话框 */
const { requireModel, promptDownload } = useModelGate()
/** 模型 store（只读） */
const modelsStore = useModelsStore()
/** 语音识别模型是否已安装 */
const asrInstalled = computed(() => !!modelsStore.get(ASR_MODEL_ID)?.installed)
/** 识别中 */
const ocrBusy = ref(false)
/** 当前识别的取消控制器 */
let controller: AbortController | null = null

/** 持久缓存 */
const store = createToolStorage(TOOL_NS)
/** 名单原文 */
const text = ref(loadNames(store))
/** 名单输入框固定行数 */
const NAME_ROWS = 5
/** 名单输入框占位提示 */
const NAME_PLACEHOLDER = '每行一个名字，逗号分隔也行，可直接粘贴'
/** 全屏输入弹层是否打开 */
const showFull = ref(false)
/** 名单输入框是否处于编辑态（默认只读，点编辑按钮进入） */
const editing = ref(false)
/** 名单输入框实例（进入编辑态时聚焦） */
const fieldRef = ref<{ focus: () => void; blur: () => void } | null>(null)

/** 切换编辑态：进入时去掉只读并聚焦，完成时收起键盘 */
function toggleEdit(): void {
  editing.value = !editing.value
  void nextTick(() => (editing.value ? fieldRef.value?.focus() : fieldRef.value?.blur()))
}
/** 共享设置（与设置页同一份）：不重复、自动停止、已抽记录 */
const { noRepeat, autoStop: settingAutoStop, spinSeconds, blurPx, idleRpm, spinRps, used, resetSeq } = useRollCallSettings()
/** 本次滚动开始时锁定的自动停止值：滚动中改设置不影响当次 */
const runAutoStop = ref(settingAutoStop.value)
/** 当前展示结果 */
const shown = ref<string[]>([])
/** 是否正在抽签表演中 */
const rolling = ref(false)
/** 手动模式下已点停止、正在减速 */
const stopping = ref(false)
/** 主按钮展示状态（文案 / 禁用 / 转圈 / 红色） */
/** 当前生效的自动停止：滚动中用锁定值，否则用设置值 */
const autoStop = computed(() => (rolling.value ? runAutoStop.value : settingAutoStop.value))
const mainBtn = computed(() => calcMainButton({ rolling: rolling.value, autoStop: autoStop.value, stopping: stopping.value, ocrBusy: ocrBusy.value }))
/** 3D 舞台是否正持有活跃渲染实例 */
const stageActive = ref(false)
/** 降级提示是否已触发（每次进入页面最多提示一次） */
const fallbackNotified = ref(false)

/** 3D 容器 DOM 引用 */
const stageRef = ref<HTMLElement | null>(null)
/** 3D 控制器实例 */
let stageInstance: RollCallStage3D | null = null
/** 3D 模块缓存 */
let stageModulePromise: Promise<typeof import('./stage3d')> | null = null

/** 滚动动画定时器：到点结算，也可在浮起时提前结算 */
const anim = createSettleTimer()
/** 手动模式的待结算回调（无定时器，滚动中保存，结算或取消时取出） */
let manualFinish: ((early: boolean) => void) | null = null

/**
 * 提前结算：自动模式走定时器，手动模式走待结算回调；没在滚动则什么也不做。
 */
function settleNow(): void {
  if (anim.settleNow()) return
  const f = manualFinish
  manualFinish = null
  f?.(true)
}

/**
 * 浮起暂停：滚动中先提前结算；舞台还在时暂停慢转，避免空转。
 */
function pauseStage(): void {
  settleNow()
  stageInstance?.setPaused(true)
}

/** 解析后的名单 */
const names = computed(() => parseNames(text.value))
/** 还剩多少人没抽（不重复模式） */
const left = computed(() => names.value.filter((n) => !used.value.includes(n)).length)

/** 名单变化落盘，并清掉已抽记录 */
watch(text, (v) => {
  saveNames(v, store)
  used.value = []
})

/** 上次已生成预览的名单指纹（空串表示舞台上没有预览） */
let lastPreviewKey = ''
/** 页面是否在前台（后台时不创建舞台、不出帧） */
let foreground = true

/**
 * 按当前名单同步 3D 预览：有效则生成清晰慢转的转子，无效则清空停渲染；滚动中不动。
 *
 * @param force 为 true 时忽略指纹强制重建（如重置）
 */
async function syncPreview(force = false): Promise<void> {
  if (rolling.value || !foreground) return
  const list = names.value
  if (!list.length) {
    lastPreviewKey = ''
    stageInstance?.clear()
    return
  }
  if (!force && !needsPreviewRebuild(list, lastPreviewKey)) return
  const stage = await initStage()
  if (!stage || rolling.value || !foreground) return
  lastPreviewKey = previewKey(list)
  stage.preview(list)
}

/** 名单输入防抖：连续输入只在停手后重建一次 */
const previewDebouncer = createDebouncer(() => void syncPreview(), PREVIEW_DEBOUNCE_MS)
/** 名单指纹变化（输入、导入、识别、语音）触发防抖重建 */
watch(
  () => previewKey(names.value),
  () => previewDebouncer.call(),
)

/**
 * 动态加载 3D 舞台模块（按需引入，利于 tree-shaking 并避免首页打包引入）。
 *
 * @returns stage3d 模块
 */
function loadStageModule(): Promise<typeof import('./stage3d')> {
  if (!stageModulePromise) {
    stageModulePromise = import('./stage3d')
  }
  return stageModulePromise
}

/**
 * 初始化 3D 滚筒舞台。
 */
async function initStage(): Promise<RollCallStage3D | null> {
  if (prefersReducedMotion()) return null
  try {
    const mod = await loadStageModule()
    if (!mod.isWebGLSupported()) return null
    if (!stageRef.value) return null
    if (!stageInstance) {
      stageInstance = mod.createRollCallStage(stageRef.value)
      stageInstance.configure({ blurPx: blurPx.value, idleRpm: idleRpm.value })
      stageActive.value = true
    }
    return stageInstance
  } catch {
    return null
  }
}

/**
 * 释放 3D 舞台与 WebGL 相关全部资源。
 */
function disposeStage(): void {
  if (stageInstance) {
    stageInstance.dispose()
    stageInstance = null
  }
  stageActive.value = false
  lastPreviewKey = ''
}

/** 用导入的文本替换整个名单、复位为只读并提示结果 */
function addNames(raw: string): void {
  const list = parseNames(raw)
  if (!list.length) {
    showToast('没有可用的名字')
    return
  }
  text.value = list.join('\n')
  editing.value = false
  fieldRef.value?.blur()
  showToast(`已导入 ${list.length} 人`)
}

/** 导入文本文件，按逗号/换行拆成名单 */
async function importText(): Promise<void> {
  try {
    const file = await pickFile({ mime: TEXT_MIME, accept: TEXT_ACCEPT, onFailed: (f) => showToast(f[0]?.message || '读取失败') })
    if (file) addNames(await file.text())
  } catch {
    showToast('读取失败')
  }
}

/** 对一张图做 OCR，识别出的文字走同一套拆分逻辑，用完即释放图片 */
async function recognize(img: PickedImage): Promise<void> {
  ocrBusy.value = true
  controller = new AbortController()
  try {
    const res = await aiOcr(await resolveImagePath(img), controller.signal)
    const raw = linesToText(groupLines(res.blocks))
    if (raw.trim()) addNames(raw)
    else showToast('没有识别到文字')
  } catch (e) {
    if (isAiCancelled(e)) return
    if (e instanceof AiNotReadyError) await handleNotReady(catalog.refresh, () => catalog.current.value?.status === 'ready', showToast, promptDownload)
    else showToast(aiErrorText(e))
  } finally {
    img.release()
    controller = null
    ocrBusy.value = false
  }
}

/** 相册选图识别名单 */
async function fromAlbum(): Promise<void> {
  if (!(await requireModel(modelReady.value))) return
  try {
    const got = await pickImages({ edit: EDIT_BASIC, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got.length) await recognize(got[0])
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照识别名单 */
async function fromCamera(): Promise<void> {
  if (!(await requireModel(modelReady.value))) return
  const img = await shootPhoto()
  if (img) await recognize(img)
}

/** 语音可用（模型齐全且引擎可加载） */
const speechOk = ref(false)
/** 正在听写（含启动中） */
const listening = ref(false)
/** 本轮听写累积的定稿句子 */
let spoken: string[] = []
/** 定稿事件取消订阅 */
let offSpeech: (() => void) | null = null

getSpeechStatus().then((s) => (speechOk.value = s.available))

/** 收尾：取消订阅并清空缓冲 */
function endSpeech(): void {
  offSpeech?.()
  offSpeech = null
  spoken = []
  listening.value = false
}

/** 语音：点一下开始听写，再点停止，识别文字走同一套拆分逻辑导入 */
async function toggleVoice(): Promise<void> {
  if (listening.value) {
    try {
      const { text: all } = await stopSpeech()
      const raw = spoken.join('\n') || all
      if (raw.trim()) addNames(raw)
      else showToast('没有听到内容')
    } catch (e) {
      showToast(speechErrorMessage(e))
    } finally {
      endSpeech()
    }
    return
  }
  if (!(await requireModel(asrInstalled.value))) return
  if (!speechOk.value) return void showToast('语音识别暂不可用')
  listening.value = true
  spoken = []
  offSpeech = onSpeechFinal((t) => t.trim() && spoken.push(t))
  try {
    await startSpeech({ lang: 'zh-en' })
  } catch (e) {
    endSpeech()
    showToast(speechErrorMessage(e))
  }
}

/** 设置页重置了已抽记录：同步清掉已展示结果 */
/** 模糊/闲时转速变化立即推给舞台 */
watch([blurPx, idleRpm], ([blur, rpm]) => stageInstance?.configure({ blurPx: blur, idleRpm: rpm }))

watch(resetSeq, () => {
  shown.value = []
  void syncPreview(true)
})

/**
 * 开抽：结果在开始时由 drawNames 定好（滚筒布局要预先放好中奖槽位，且“不重复”的已抽记录
 * 只在结算时才写入，中途取消也不会错记），3D 只表演；手动模式下滚动中再点一次即停止。
 */
async function roll(): Promise<void> {
  if (rolling.value) {
    if (!autoStop.value && !stopping.value) {
      stopping.value = true
      stageInstance?.stop()
    }
    return
  }
  if (!names.value.length) {
    showToast('先输入名单')
    return
  }
  const r = drawNames(names.value, 1, noRepeat.value, used.value)
  if (!r.picked.length) {
    showToast('名单已抽完，点“重置”再来')
    return
  }

  const winner = r.picked[0]
  runAutoStop.value = settingAutoStop.value

  /** 结果回调只触发一次（动画回调与兜底定时器可能先后到达） */
  let finished = false
  const finish = (early = false): void => {
    if (finished) return
    finished = true
    shown.value = r.picked
    used.value = r.used
    rolling.value = false
    stopping.value = false
    if (early) {
      stageInstance?.settleNow()
      disposeStage()
    }
    if (!early && r.exhausted && noRepeat.value) {
      showToast('名单抽完了，点“重置”可重新开始')
    }
  }

  // 检查是否具备 3D 条件
  if (prefersReducedMotion()) {
    if (!fallbackNotified.value) {
      fallbackNotified.value = true
      showToast(TOAST_MOTION_REDUCED)
    }
    finish()
    return
  }

  const stage = await initStage()
  if (!stage) {
    if (!fallbackNotified.value) {
      fallbackNotified.value = true
      showToast(TOAST_NO_WEBGL)
    }
    finish()
    return
  }

  rolling.value = true
  stageActive.value = true
  previewDebouncer.cancel()
  lastPreviewKey = ''
  if (autoStop.value) {
    // 动画走完按“非提前”结算，舞台继续播停顿→弹出→慢转；定时器仅作兜底
    const durationMs = spinSeconds.value * 1000
    stage.play(
      names.value,
      winner,
      () => {
        anim.clear()
        finish(false)
      },
      { durationMs, spinRps: spinRps.value },
    )
    anim.start(finish, durationMs + ANIM_FALLBACK_MS)
  } else {
    manualFinish = finish
    stage.play(
      names.value,
      winner,
      () => {
        const f = manualFinish
        manualFinish = null
        f?.(false)
      },
      { manual: true, spinRps: spinRps.value },
    )
  }
}

/**
 * 浮起 / 离开前台：滚动中就直接结算到已定好的结果（并记入已抽名单），回来看到的是结果；
 * 没在滚动时什么也不做。
 */
useFloatPause({
  pause: () => void pauseStage(),
  /** 恢复结算后的慢转（滚动中的已提前结算并释放舞台，无需恢复） */
  resume: () => {
    foreground = true
    if (stageInstance) stageInstance.setPaused(false)
    else if (!shown.value.length) void syncPreview()
  },
})

/** 当前路由：进设置页时首页只是被藏起来，3D 滚筒要自己停 */
const route = useRoute()
/** 进设置页暂停滚筒（滚动中先结算），回首页恢复慢转 */
watch(
  () => route.name === TOOL_SETTING_ROUTE,
  (inSetting) => {
    if (inSetting) pauseStage()
    else stageInstance?.setPaused(false)
  },
)

/** 离开前台：停掉听写，别让麦克风一直开着 */
function stopVoiceQuietly(): void {
  if (!listening.value) return
  endSpeech()
  void stopSpeech().catch(() => undefined)
}

onMounted(() => {
  void syncPreview()
})

onDeactivated(() => {
  foreground = false
  previewDebouncer.cancel()
  controller?.abort()
  stopVoiceQuietly()
  settleNow()
  disposeStage()
})

onBeforeUnmount(() => {
  foreground = false
  previewDebouncer.cancel()
  anim.clear()
  manualFinish = null
  controller?.abort()
  stopVoiceQuietly()
  disposeStage()
})
</script>

<template>
  <div class="tool-page">
    <div ref="stageRef" class="rc-stage" :class="{ 'rc-stage--rolling': rolling }">
      <!-- 3D 舞台 Canvas 挂载在内部；未启用 3D 或浮起释放后回落为平面展示 -->
      <div v-if="!stageActive || (!names.length && !rolling)" class="rc-fallback-layer">
        <span v-if="!shown.length" class="rc-empty">点“开抽”点名</span>
        <b v-else class="rc-name">{{ shown[0] }}</b>
      </div>
    </div>

    <tool-group title="名单">
      <van-field ref="fieldRef" v-model="text" type="textarea" :rows="NAME_ROWS" :readonly="!editing" :placeholder="NAME_PLACEHOLDER" />
      <div class="rc-foot">
        <p class="tool-hint">共 {{ names.length }} 人（重复姓名只算一次）<span v-if="noRepeat">，还剩 {{ left }} 人没抽</span></p>
        <div class="rc-foot__actions">
          <button type="button" class="rc-foot__btn" :aria-label="editing ? '完成编辑' : '编辑名单'" @click="toggleEdit">
            <svg v-if="!editing" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </button>
          <button type="button" class="rc-foot__btn" aria-label="全屏编辑" @click="showFull = true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
              <rect x="7" y="8" width="10" height="8" rx="1" />
            </svg>
          </button>
        </div>
      </div>
    </tool-group>

    <!-- 全屏输入：自动高度，方便输入长名单；与主输入框共用同一份文本 -->
    <van-popup v-model:show="showFull" position="bottom" teleport="body" :style="{ width: '100%', height: '100%', maxHeight: '100%' }">
      <div class="rc-full">
        <div class="rc-full__bar">
          <span class="rc-full__title">编辑名单</span>
          <van-button size="small" type="primary" @click="showFull = false">完成</van-button>
        </div>
        <van-field v-model="text" type="textarea" rows="1" autosize :placeholder="NAME_PLACEHOLDER" class="rc-full__field" />
      </div>
    </van-popup>

    <model-missing-notice v-if="catalogReady && !modelReady" />

    <!-- 导入文本 / 相册 / 拍照（OCR）/ 语音 都会替换整个名单；相册、拍照需要文字识别模型 -->
    <bottom-actions
      :main-loading="mainBtn.loading"
      ai
      :actions="{ import: true, voice: { disabled: ocrBusy || rolling, text: listening ? '停止' : '语音', color: listening ? 'var(--van-danger-color)' : undefined } }"
      album
      photo
      main
      :main-text="mainBtn.text"
      :main-color="mainBtn.danger ? DANGER_COLOR : undefined"
      :disabled="{ main: mainBtn.disabled, album: ocrBusy, photo: ocrBusy, import: ocrBusy }"
      @import="importText"
      @voice="toggleVoice"
      @album="fromAlbum"
      @photo="fromCamera"
      @main="roll"
    >
      <template #ai><model-picker :tool-id="TOOL_ID" variant="bar" :disabled="ocrBusy" /></template>
    </bottom-actions>
  </div>
</template>

<style lang="scss" scoped>
/* 固定暗色 3D 舞台卡片 */
.rc-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: var(--tool-card-radius);
  background: #0e1017;
  color: #ffffff;
  overflow: hidden;
  box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.08);

  &--rolling {
    box-shadow: inset 0 0 30px rgba(59, 108, 246, 0.15);
  }
}

/* 兜底 / 静态文字展示层 */
.rc-fallback-layer {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: $space-4;
  z-index: 1;
}

/* 占位提示 */
.rc-empty {
  color: rgba(255, 255, 255, 0.5);
  font-size: 16px;
}

/* 名字 */
.rc-name {
  font-size: 38px;
  line-height: 1.3;
  color: #ffffff;
  text-shadow: 0 0 16px var(--van-primary-color, #3b6cf6);
}

/* 名单底栏：左侧统计，右侧全屏按钮 */
.rc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 右侧按钮组：编辑 / 全屏 */
  &__actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 16px;
  }
  /* 图标按钮：原生 button，无边框无底色 */
  &__btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    padding: 0;
    border: none;
    background: none;
    line-height: 1;
    color: var(--van-primary-color);
    cursor: pointer;
  }
}

/* 全屏输入：顶部标题栏 + 自动增高的输入框，整体可滚动 */
.rc-full {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding-top: var(--safe-top);
  background: var(--van-background-2);
  &__bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
  }
  &__title {
    font-size: 16px;
    font-weight: 600;
  }
  &__field {
    flex: 1;
    overflow-y: auto;
    align-items: flex-start;
  }
}
</style>
