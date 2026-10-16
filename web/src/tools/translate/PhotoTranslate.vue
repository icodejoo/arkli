<script setup lang="ts">
// 图片翻译区：由翻译页底部动作栏驱动。取图（拍照 / 相册可多选）后只显示图片，点「翻译」才逐张 OCR + 逐块翻译，
// 处理中图上有上下扫描效果，译文叠在原图对应位置；可弹窗看原文译文整段文本。
// 拍照一律走原生 captureCamera，相册走 native.file.pick（无宿主时才退回 input 兜底）。模型状态只读 AI 目录，下载等都在 AI 中心。
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { pickImages, type PickedImage } from '@/shared/image-io'
import { captureCamera, cameraItemToPicked, clearCamera, isCancelled, isAlbum } from '@/native/camera'
import { isNativeAvailable } from '@/native/bridge'
import { aiOcr, aiTranslate, isAiCancelled } from '@/native/ai'
import { useAiCatalog } from '@/native/useAiCatalog'
import { resolveImagePath } from '../_ai/aiImage'
import { isPairSupported, PROVIDER_QWEN } from './shortInput'
import { runPhotoTranslate, type PhotoInput } from './photoRun'
import {
  aggregateText,
  aggregateTranslated,
  displayScale,
  initProgress,
  itemPairsText,
  MAX_PHOTOS,
  overlayCss,
  overlayStyle,
  progressPercent,
  progressText,
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
/** 当前预览的是第几张 */
const active = ref(0)
/** 查看文本弹窗 */
const showText = ref(false)
/** 取消控制器 */
let controller: AbortController | null = null
/** 本轮持有的图片（清除或换批时释放） */
let held: PickedImage[] = []

/** 预览区容器与其显示宽（叠层换算用） */
const stage = ref<HTMLElement | null>(null)
const stageWidth = ref(0)
/** 监听容器尺寸变化 */
let observer: ResizeObserver | null = null

/** 是否有图（图片模式） */
const hasImages = computed(() => items.value.length > 0)
/** 进度条文案 */
const progressLabel = computed(() => (progress.value ? progressText(progress.value) : ''))
/** 进度百分比（处理中把当前张算半格，视觉上更连贯） */
const percent = computed(() => (progress.value ? progressPercent(progress.value) : 0))
/** 整段文本（弹窗复制全部用） */
const allText = computed(() => aggregateText(items.value))
/** 有任何文字块结果时才允许看文本 */
const hasText = computed(() => allText.value.length > 0)
/** 只含译文的整段文本（页面的「复制」用） */
const translatedText = computed(() => aggregateTranslated(items.value))

// 预览容器只在有图时才渲染：出现时开始量宽，消失时停止
watch(stage, (el) => {
  observer?.disconnect()
  observer = null
  if (!el || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver((es) => {
    stageWidth.value = es[0]?.contentRect.width ?? 0
  })
  observer.observe(el)
})
onMounted(() => {
  stageWidth.value = stage.value?.clientWidth ?? 0
})

/** 某张图上每个译文块的叠层样式（框在原图像素，按显示宽缩放） */
function overlays(it: PhotoItemResult): Array<{ key: number; text: string; style: Record<string, string> }> {
  const k = displayScale(it.width, stageWidth.value)
  return it.blocks
    .map((b, key) => ({ key, text: b.tgt, style: overlayCss(overlayStyle(b.box, k, b.tgt)) }))
    .filter((o) => o.text)
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

/** 对已载入的图片逐张识别并翻译；没图、正在处理或模型没就绪时什么也不做 */
async function run(): Promise<void> {
  if (!held.length || busy.value) return
  if (!trCatalog.ready.value) await trCatalog.refresh()
  const provider = trCatalog.current.value?.providerId
  if (!provider || !modelsReady.value) return
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
    // 撞上模型未就绪：重新探测目录，提示条随之出现，不弹下载相关文案
    if (out.notReady) await Promise.all([trCatalog.refresh(), ocrCatalog.refresh()])
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
  observer?.disconnect()
  clear()
})

/** 供翻译页读取状态、驱动动作 */
defineExpose({ fromCamera, fromAlbum, run, cancel, clear, hasImages, busy, hasText, translatedText, modelsReady, showMissing })
</script>

<template>
  <div v-if="hasImages" class="pt">
    <div v-if="progress && busy" class="pt__progress">
      <van-progress :percentage="percent" :show-pivot="false" stroke-width="4" />
      <p class="pt__progress-text">{{ progressLabel }}</p>
    </div>

    <!-- 预览：多图可横滑 -->
    <div ref="stage" class="pt__stage">
      <van-swipe :show-indicators="items.length > 1" :loop="false" :initial-swipe="active" @change="active = $event">
        <van-swipe-item v-for="(it, i) in items" :key="i">
          <div class="pt__slide">
            <img class="pt__img" :src="it.url" :alt="it.name" />
            <div class="pt__layer">
              <div v-for="o in overlays(it)" :key="o.key" class="pt__box" :style="o.style">{{ o.text }}</div>
            </div>
            <!-- 处理中：上下往返的扫描线 -->
            <div v-if="it.status === 'running'" class="pt__scan" aria-hidden="true" />
            <div v-if="it.status === 'running'" class="pt__tag"><van-loading size="14px" color="#fff">识别中</van-loading></div>
            <div v-else-if="it.status === 'failed'" class="pt__tag pt__tag--err">{{ it.error }}</div>
            <div v-else-if="it.status === 'cancelled'" class="pt__tag">已取消</div>
            <div v-else-if="it.status === 'pending' && busy" class="pt__tag">排队中</div>
          </div>
        </van-swipe-item>
      </van-swipe>
    </div>

    <div class="pt__actions">
      <van-button type="primary" round size="small" :disabled="!hasText" @click="showText = true">查看文本</van-button>
      <van-button plain round size="small" :disabled="busy" @click="clear">移除图片</van-button>
    </div>

    <van-popup v-model:show="showText" position="bottom" round closeable :style="{ height: '75%' }">
      <div class="pt__pop">
        <h3 class="pt__pop-title">原文与译文</h3>
        <div class="pt__pop-actions">
          <van-button size="mini" plain round :disabled="!hasText" @click="copy(allText)">复制全部</van-button>
          <van-button size="mini" plain round :disabled="!hasText" @click="copy(translatedText)">只复制译文</van-button>
        </div>
        <div class="pt__pop-body">
          <section v-for="(it, i) in items" :key="i" class="pt__group">
            <h4 class="pt__group-title">
              <span>第 {{ i + 1 }} 张 · {{ it.name }}</span>
              <van-button v-if="it.blocks.length" size="mini" plain round @click="copy(itemPairsText(it))">复制</van-button>
            </h4>
            <p v-if="!it.blocks.length" class="pt__muted">{{ it.error || '无文字' }}</p>
            <div v-for="(b, j) in it.blocks" :key="j" class="pt__pair">
              <p class="pt__src">{{ b.src }}</p>
              <p class="pt__tgt">{{ b.tgt || '（翻译失败）' }}</p>
            </div>
          </section>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style lang="scss" scoped>
.pt__actions {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  margin-top: $space-3;
}

.pt__progress {
  margin-bottom: $space-3;
}

.pt__progress-text {
  margin: $space-1 0 0;
  font-size: 12px;
  color: var(--c-text-muted);
}

// 图片按宽度铺满，叠层与图同尺寸绝对定位，译文框坐标相对图片左上角
.pt__slide {
  position: relative;
  overflow: hidden;
  line-height: 0;
}

.pt__img {
  display: block;
  width: 100%;
  height: auto;
}

.pt__layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

// 译文块：半透明深底白字保证可读；字号由逻辑层按框高算出
.pt__box {
  position: absolute;
  display: flex;
  align-items: center;
  overflow: hidden;
  line-height: 1.2;
  color: #fff;
  word-break: break-all;
  background: rgb(0 0 0 / 92%);
  border-radius: 2px;
}

// 扫描线：沿图片上下往返，带光晕
.pt__scan {
  position: absolute;
  right: 0;
  left: 0;
  height: 3px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--c-primary, #1989fa), transparent);
  box-shadow: 0 0 12px 3px var(--c-primary, #1989fa);
  animation: pt-scan 1.6s ease-in-out infinite alternate;
}

@keyframes pt-scan {
  from {
    top: 0;
  }

  to {
    top: calc(100% - 3px);
  }
}

.pt__tag {
  position: absolute;
  right: $space-2;
  bottom: $space-2;
  padding: 2px $space-2;
  font-size: 12px;
  line-height: 1.5;
  color: #fff;
  background: rgb(0 0 0 / 55%);
  border-radius: 10px;
}

.pt__tag--err {
  background: rgb(220 50 50 / 80%);
}

.pt__pop {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: $space-3;
}

.pt__pop-title {
  margin: 0;
  font-size: 16px;
}

.pt__pop-actions {
  display: flex;
  gap: $space-2;
  margin: $space-2 0;
}

.pt__pop-body {
  flex: 1;
  overflow-y: auto;
  user-select: text;
}

.pt__group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: $space-3 0 $space-1;
  font-size: 13px;
  color: var(--c-text-muted);
}

.pt__pair {
  padding: $space-2 0;
  border-bottom: 1px solid var(--c-border, rgb(128 128 128 / 20%));
}

.pt__src,
.pt__tgt,
.pt__muted {
  margin: 0;
  word-break: break-word;
  white-space: pre-wrap;
}

.pt__src {
  font-size: 13px;
  color: var(--c-text-muted);
}

.pt__tgt {
  margin-top: 2px;
  font-size: 15px;
  color: var(--c-text);
}

.pt__muted {
  font-size: 13px;
  color: var(--c-text-muted);
}
</style>
