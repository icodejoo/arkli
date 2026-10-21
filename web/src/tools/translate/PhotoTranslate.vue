<script setup lang="ts">
// 图片翻译区：由翻译页底部动作栏驱动。取图（拍照 / 相册可多选）后只显示图片，点「翻译」才逐张 OCR + 逐块翻译，
// 处理中图上有上下扫描效果，译文叠在原图对应位置；可弹窗看原文译文整段文本。
// 拍照一律走原生 captureCamera，相册走 native.file.pick（无宿主时才退回 input 兜底）。模型状态只读 AI 目录，下载等都在 AI 中心。
import { computed, onBeforeUnmount, onDeactivated, ref } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { pickImages, type PickedImage } from '@/shared/image-io'
import { formatBytes } from '@/shared/image-calc'
import { resolveActionIcon } from '@/shared/bottomActionIcons'
import ThumbPreview from '@/shared/ThumbPreview.vue'
import { captureCamera, cameraItemToPicked, clearCamera, isCancelled, isAlbum } from '@/native/camera'
import { isNativeAvailable } from '@/native/bridge'
import { aiOcr, aiTranslate, isAiCancelled } from '@/native/ai'
import { useAiCatalog } from '@/native/useAiCatalog'
import { useModelGate } from '@/shared/modelGate'
import { resolveImagePath } from '../_ai/aiImage'
import { isPairSupported, PROVIDER_QWEN } from './shortInput'
import { runPhotoTranslate, type PhotoInput } from './photoRun'
import {
  aggregateText,
  aggregateTranslated,
  itemTranslated,
  initProgress,
  itemPairsText,
  MAX_PHOTOS,
  type PhotoItemResult,
  type PhotoProgress,
} from './photoLogic'

/** 翻译页的工具 id（与 registry 一致，用它的目录取翻译模型） */
const TRANSLATE_TOOL_ID = 'translate'
/** 文字识别的工具 id（用它的目录取 OCR 模型状态） */
const OCR_TOOL_ID = 'ocr'
/** 取图失败提示 */
const MSG_PICK_FAILED = '选图失败'
/** 没识别到文字的提示 */
const MSG_NO_TEXT = '没有识别到文字'
/** 复制成功提示 */
const MSG_COPIED = '已复制'
/** 复制失败提示 */
const MSG_COPY_FAILED = '复制失败，请手动长按选择'

const props = defineProps<{
  /** 当前语言对（源可为 auto） */
  pair: { src: string; tgt: string }
}>()
const emit = defineEmits<{
  /** 本轮改走了 Qwen（页面据此登记占用，离页卸载） */
  (e: 'use-qwen'): void
}>()

/** 翻译模型目录（只读） */
const trCatalog = useAiCatalog(TRANSLATE_TOOL_ID)
/** 文字识别模型目录（只读） */
const ocrCatalog = useAiCatalog(OCR_TOOL_ID)

/** 模型缺失闸门：没模型时点翻译弹「去下载」对话框 */
const { promptDownload } = useModelGate()

/** 翻译与 OCR 模型是否都就绪 */
const modelsReady = computed(() => trCatalog.current.value?.status === 'ready' && ocrCatalog.current.value?.status === 'ready')
/** 两个目录都探测过、却有模型没就绪：页面据此显示提示条（探测前不闪） */
const showMissing = computed(() => trCatalog.ready.value && ocrCatalog.ready.value && !modelsReady.value)

/** 各张图的结果（按选图顺序） */
const items = ref<PhotoItemResult[]>([])
/** 进度 */
const progress = ref<PhotoProgress | null>(null)
/** 是否正在处理 */
const busy = ref(false)
/** 弹窗正在看第几张 */
const active = ref(0)
/** 查看文本弹窗 */
const showText = ref(false)
/** 复制图标组件 */
const CopyIcon = resolveActionIcon('arkli:copy')
/** 状态文案：已识别 / 未识别 / 识别错误（失败时为错误原因） */
const STATUS_DONE = '已识别'
const STATUS_NONE = '未识别'
const STATUS_ERROR = '识别错误'
/** 取消控制器 */
let controller: AbortController | null = null
/** 本轮持有的图片（清除或换批时释放） */
let held: PickedImage[] = []

/** 是否有图（图片模式） */
const hasImages = computed(() => items.value.length > 0)
/** 整段文本（有任何文字块才允许复制） */
const allText = computed(() => aggregateText(items.value))
/** 有任何文字块结果时为真 */
const hasText = computed(() => allText.value.length > 0)
/** 只含译文的整段文本（页面的「复制」用） */
const translatedText = computed(() => aggregateTranslated(items.value))

/** 弹窗里当前这张图 */
const current = computed(() => items.value[active.value])
/** 当前这张的整段文本（复制全部） */
const curAll = computed(() => (current.value ? itemPairsText(current.value) : ''))
/** 当前这张只含译文（只复制译文） */
const curTranslated = computed(() => (current.value ? itemTranslated(current.value) : ''))

/** 某张图的描述：大小 + 识别状态（识别错误带原因） */
function descOf(it: PhotoItemResult, i: number): string {
  const size = held[i] ? formatBytes(held[i].size) : ''
  const st = it.status === 'done' && it.blocks.length ? STATUS_DONE : it.status === 'failed' ? (it.error ? `${STATUS_ERROR}：${it.error}` : STATUS_ERROR) : it.status === 'running' ? '识别中' : STATUS_NONE
  return [size, st].filter(Boolean).join(' · ')
}

/** 该张是否已识别出文字（才可点开看） */
function recognized(it: PhotoItemResult): boolean {
  return it.status === 'done' && it.blocks.length > 0
}

/** 点击某行：已识别才拉起弹窗 */
function open(i: number): void {
  if (!recognized(items.value[i])) return
  active.value = i
  showText.value = true
}

/** 释放上一批图片 */
function releaseHeld(): void {
  held.forEach((i) => i.release())
  held = []
}

/** 拍照：原生相机；相机里点相册则转相册选；无宿主退回单张 input 选图 */
async function fromCamera(): Promise<void> {
  try {
    if (!isNativeAvailable()) return load(await pickImages({ multiple: false }))
    const r = await captureCamera({ modes: ['photo', 'album'] })
    if (isCancelled(r)) return
    if (isAlbum(r)) return await fromAlbum()
    if (r.kind === 'image') load([cameraItemToPicked(r)])
  } catch (e) {
    showToast((e as { message?: string }).message ?? MSG_PICK_FAILED)
  }
}

/** 相册多选：原生自带选图页（无宿主时 input 兜底） */
async function fromAlbum(): Promise<void> {
  try {
    const got = await pickImages({ multiple: true, max: MAX_PHOTOS, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    load(got)
  } catch (e) {
    showToast((e as { message?: string }).message ?? MSG_PICK_FAILED)
  }
}

/** 把图片列表转成“待处理”的结果行 */
function pendingItems(picked: PickedImage[]): PhotoItemResult[] {
  return picked.map((p) => ({ name: p.name, url: p.url, width: 0, height: 0, status: 'pending', blocks: [] }))
}

/**
 * 载入一批图片：换掉旧图与旧结果，只显示图，不识别（点「翻译」才跑）。
 *
 * @param picked 选到的图片；空数组或正在处理时直接释放
 */
function load(picked: PickedImage[]): void {
  if (!picked.length || busy.value) {
    picked.forEach((i) => i.release())
    return
  }
  releaseHeld()
  held = picked
  active.value = 0
  progress.value = null
  items.value = pendingItems(picked)
}

/** 清掉图片与结果，回到文字模式 */
function clear(): void {
  controller?.abort()
  releaseHeld()
  void clearCamera()
  items.value = []
  progress.value = null
  active.value = 0
}

/** 对已载入的图片逐张识别并翻译；没图或正在处理时什么也不做，模型没就绪弹「去下载」对话框 */
async function run(): Promise<void> {
  if (!held.length || busy.value) return
  if (!trCatalog.ready.value) await trCatalog.refresh()
  const provider = trCatalog.current.value?.providerId
  if (!ocrCatalog.ready.value) await ocrCatalog.refresh()
  if (!provider || !modelsReady.value) return void promptDownload()
  const picked = held
  const ac = new AbortController()
  controller = ac
  busy.value = true
  active.value = 0
  items.value = pendingItems(picked)
  progress.value = initProgress(picked.length)
  try {
    const inputs: PhotoInput[] = []
    for (const p of picked) inputs.push({ name: p.name, url: p.url, path: await resolveImagePath(p) })
    const qwen = trCatalog.items.value.find((i) => i.providerId === PROVIDER_QWEN)
    const out = await runPhotoTranslate(
      inputs,
      {
        provider,
        src: props.pair.src,
        tgt: props.pair.tgt,
        qwenReady: qwen?.status === 'ready',
        qwenSupportsPair: !!qwen && isPairSupported(qwen.constraints, props.pair),
        onUseQwen: () => emit('use-qwen'),
      },
      { ocr: (path, signal) => aiOcr(path, signal), translate: (params, signal) => aiTranslate(params, signal) },
      {
        onItem: (i, it) => (items.value[i] = it),
        onProgress: (p) => (progress.value = p),
      },
      ac.signal,
    )
    // 撞上模型未就绪：重新探测目录，提示条随之出现，并弹「去下载」对话框
    if (out.notReady) {
      await Promise.all([trCatalog.refresh(), ocrCatalog.refresh()])
      void promptDownload()
    }
    else if (!ac.signal.aborted && !items.value.some((i) => i.blocks.length)) showToast(MSG_NO_TEXT)
  } catch (e) {
    if (!isAiCancelled(e)) showFailToast((e as { message?: string }).message ?? '处理失败')
  } finally {
    if (controller === ac) controller = null
    busy.value = false
  }
}

/** 取消处理 */
function cancel(): void {
  controller?.abort()
}

/** 复制文本并提示 */
async function copy(text: string): Promise<void> {
  if (await copyText(text)) showSuccessToast(MSG_COPIED)
  else showFailToast(MSG_COPY_FAILED)
}

onDeactivated(() => controller?.abort())
onBeforeUnmount(() => {
  clear()
})

/** 供翻译页读取状态、驱动动作 */
defineExpose({ fromCamera, fromAlbum, run, cancel, clear, hasImages, busy, hasText, translatedText, modelsReady, showMissing })
</script>

<template>
  <template v-if="hasImages">
    <!-- 预览列表：缩略图（处理中带扫描线）+ 图名 + 大小/识别状态；已识别才显示右箭头 -->
    <van-cell-group inset class="pt__list">
      <van-cell v-for="(it, i) in items" :key="i" :title="it.name" :label="descOf(it, i)" :is-link="recognized(it)" :clickable="recognized(it)" @click="open(i)">
        <template #icon>
          <thumb-preview :url="it.url" :path="held[i]?.path" :alt="it.name" :scanning="it.status === 'running'" />
        </template>
      </van-cell>
    </van-cell-group>

    <van-popup v-model:show="showText" position="bottom" round closeable teleport="body" :style="{ height: '75%' }">
      <div v-if="current" class="pt__pop">
        <thumb-preview class="pt__pop-thumb" :url="current.url" :path="held[active]?.path" :alt="current.name" :size="48" />
        <van-cell-group class="pt__pop-body">
          <van-cell v-for="(b, j) in current.blocks" :key="j" :title="b.src" :label="b.tgt || '（翻译失败）'" title-class="pt__src" label-class="pt__tgt">
            <template #value>
              <van-button v-if="b.tgt" size="small" plain round class="pt__copy" @click="copy(b.tgt)">
                <component :is="CopyIcon" class="pt__copy-icon" />
              </van-button>
            </template>
          </van-cell>
        </van-cell-group>
        <div class="pt__foot">
          <van-button plain round block type="primary" :disabled="!curAll" @click="copy(curAll)">复制全部</van-button>
          <van-button round block type="primary" :disabled="!curTranslated" @click="copy(curTranslated)">只复制译文</van-button>
        </div>
      </div>
    </van-popup>
  </template>
</template>

<style lang="scss" scoped>
.pt__pop {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: $space-3;
  background: var(--van-popup-background, var(--c-bg, #fff));
}

// 缩略图当标题，去掉默认右边距
.pt__pop-thumb {
  margin: 0 0 $space-2;
}

// 底部两个按钮：次按钮在左、主按钮在右，固定在弹窗底部（含手势条）
.pt__foot {
  display: flex;
  flex: none;
  gap: $space-2;
  padding-top: $space-3;
  padding-bottom: var(--safe-bottom);
}

.pt__copy {
  --van-button-border-width: 0;

  background: transparent;
}

.pt__pop-body {
  flex: 1;
  overflow-y: auto;
  user-select: text;
}

.pt__copy-icon {
  width: 18px;
  height: 18px;
}

.pt__list {
  margin: 0;
}

:deep(.pt__src),
:deep(.pt__tgt) {
  margin: 0;
  word-break: break-word;
  white-space: pre-wrap;
}

:deep(.pt__src) {
  font-size: 13px;
  color: var(--c-text-muted);
}

:deep(.pt__tgt) {
  margin-top: 2px;
  font-size: 15px;
  color: var(--c-text);
}
</style>
