<script setup lang="ts">
// 随机点名：粘贴名单，抽 1 人，可选不重复，Three.js 3D 滚筒舞台表演
import BottomActions from '@/shared/BottomActions.vue'
import { useFloatPause } from '@/shared/useFloatPause'
import ModelPicker from '@/shared/ModelPicker.vue'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { showToast } from 'vant'
import { pickFile } from '@/shared/file-pick'
import { EDIT_BASIC, pickImages, type PickedImage } from '@/shared/image-io'
import { shootPhoto } from '@/shared/shootPhoto'
import { aiOcr, AiNotReadyError, isAiCancelled } from '@/native/ai'
import { useAiCatalog } from '@/native/useAiCatalog'
import { aiErrorText, handleNotReady, resolveImagePath } from '@/tools/_ai/aiImage'
import { groupLines, linesToText } from '../ocr/logic'
import { getSpeechStatus, onSpeechFinal, speechErrorMessage, startSpeech, stopSpeech } from '@/native/speech'
import { prefersReducedMotion } from '@/shared/motion'
import { createSettleTimer } from '../coin-flip/logic'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { drawNames, loadNames, parseNames, saveNames, TOOL_NS } from './logic'
import type { RollCallStage3D } from './stage3d'

/** 动画安全超时与兜底时长（毫秒） */
const ANIM_MS = 1400

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
/** 识别中提示文案 */
const TEXT_OCR_BUSY = '识别中'
/** 开抽文案 */
const TEXT_ROLL = '开抽'

/** 本工具的 AI 目录：模型状态只读（下载等都在 AI 中心） */
const catalog = useAiCatalog(TOOL_ID)
/** 目录是否已探测过 */
const catalogReady = catalog.ready
/** 文字识别模型是否就绪 */
const modelReady = computed(() => catalog.current.value?.status === 'ready')
/** 识别中 */
const ocrBusy = ref(false)
/** 当前识别的取消控制器 */
let controller: AbortController | null = null

/** 持久缓存 */
const store = createToolStorage(TOOL_NS)
/** 名单原文 */
const text = ref(loadNames(store))
/** 不重复模式（持久化） */
const noRepeat = usePersistedRef<boolean>(store, 'noRepeat', false, (v) => typeof v === 'boolean')
/** 已抽过的人 */
const used = ref<string[]>([])
/** 当前展示结果 */
const shown = ref<string[]>([])
/** 是否正在抽签表演中 */
const rolling = ref(false)
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

/** 解析后的名单 */
const names = computed(() => parseNames(text.value))
/** 还剩多少人没抽（不重复模式） */
const left = computed(() => names.value.filter((n) => !used.value.includes(n)).length)

/** 名单变化落盘，并清掉已抽记录 */
watch(text, (v) => {
  saveNames(v, store)
  used.value = []
})

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
}

/** 用导入的文本替换整个名单并提示结果 */
function addNames(raw: string): void {
  const list = parseNames(raw)
  if (!list.length) {
    showToast('没有可用的名字')
    return
  }
  text.value = list.join('\n')
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
    if (e instanceof AiNotReadyError) await handleNotReady(catalog.refresh, () => catalog.current.value?.status === 'ready', showToast)
    else showToast(aiErrorText(e))
  } finally {
    img.release()
    controller = null
    ocrBusy.value = false
  }
}

/** 相册选图识别名单 */
async function fromAlbum(): Promise<void> {
  try {
    const got = await pickImages({ edit: EDIT_BASIC, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got.length) await recognize(got[0])
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照识别名单 */
async function fromCamera(): Promise<void> {
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

/** 重置已抽记录 */
function resetUsed(): void {
  used.value = []
  shown.value = []
}

/** 开抽：结果由 drawNames 先定好，3D 只表演，降级时直接出文字 */
async function roll(): Promise<void> {
  if (rolling.value) return
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

  const finish = (early = false): void => {
    shown.value = r.picked
    used.value = r.used
    rolling.value = false
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
  stage.play(names.value, winner, () => {
    anim.settleNow()
  })
  anim.start(finish, ANIM_MS)
}

/**
 * 浮起 / 离开前台：滚动中就直接结算到已定好的结果（并记入已抽名单），回来看到的是结果；
 * 没在滚动时什么也不做。
 */
useFloatPause({
  pause: () => void anim.settleNow(),
  /** 无需恢复：结果已经落定 */
  resume: () => {},
})

/** 离开前台：停掉听写，别让麦克风一直开着 */
function stopVoiceQuietly(): void {
  if (!listening.value) return
  endSpeech()
  void stopSpeech().catch(() => undefined)
}

onMounted(() => {
  void initStage()
})

onDeactivated(() => {
  controller?.abort()
  stopVoiceQuietly()
  anim.settleNow()
  disposeStage()
})

onBeforeUnmount(() => {
  anim.clear()
  controller?.abort()
  stopVoiceQuietly()
  disposeStage()
})
</script>

<template>
  <div class="tool-page">
    <div ref="stageRef" class="rc-stage" :class="{ 'rc-stage--rolling': rolling }">
      <!-- 3D 舞台 Canvas 挂载在内部；未启用 3D 或浮起释放后回落为平面展示 -->
      <div v-if="!stageActive" class="rc-fallback-layer">
        <span v-if="!shown.length" class="rc-empty">点“开抽”点名</span>
        <b v-else class="rc-name">{{ shown[0] }}</b>
      </div>
    </div>

    <tool-group title="名单">
      <van-field v-model="text" type="textarea" rows="5" autosize placeholder="每行一个名字，逗号分隔也行，可直接粘贴" />
      <p class="tool-hint">共 {{ names.length }} 人（重复姓名只算一次）<span v-if="noRepeat">，还剩 {{ left }} 人没抽</span></p>
    </tool-group>

    <tool-group title="设置">
      <van-cell title="不重复（抽过的不再抽）" center>
        <template #value><van-switch v-model="noRepeat" size="22" @change="resetUsed" /></template>
      </van-cell>
      <van-button v-if="noRepeat" size="small" plain @click="resetUsed">重置已抽记录</van-button>
    </tool-group>

    <model-missing-notice v-if="catalogReady && !modelReady" />

    <!-- 导入文本 / 相册 / 拍照（OCR）/ 语音 都会替换整个名单；相册、拍照需要文字识别模型 -->
    <bottom-actions
      :main-loading="rolling || ocrBusy"
      ai
      :actions="{ import: true, voice: { disabled: !speechOk || ocrBusy || rolling, text: listening ? '停止' : '语音', color: listening ? 'var(--van-danger-color)' : undefined } }"
      album
      photo
      main
      :main-text="ocrBusy ? TEXT_OCR_BUSY : TEXT_ROLL"
      :disabled="{ main: rolling || ocrBusy, album: ocrBusy || !modelReady, photo: ocrBusy || !modelReady, import: ocrBusy }"
      @import="importText"
      @voice="toggleVoice"
      @album="fromAlbum"
      @photo="fromCamera"
      @main="roll"
    >
      <template #ai><model-picker :tool-id="TOOL_ID" variant="bar" /></template>
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
  min-height: 220px;
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
</style>
