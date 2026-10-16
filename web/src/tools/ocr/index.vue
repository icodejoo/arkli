<script setup lang="ts">
// 文字识别：选图 → 本地 OCR → 按阅读顺序排行 → 逐行/全文复制，识别框叠加在原图上
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, onDeactivated, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { EDIT_BASIC, pickImages, type PickedImage } from '@/shared/image-io'
import { shootPhoto } from '@/shared/shootPhoto'
import { aiOcr, AiNotReadyError, type OcrResult } from '@/native/ai'
import { useAiCatalog } from '@/native/useAiCatalog'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import { aiErrorText, handleNotReady, resolveImagePath } from '@/tools/_ai/aiImage'
import { isAiCancelled } from '@/native/ai'
import { boxPoints } from '@/tools/_ai/ocrBox'
import { averageScore, groupLines, lineIndexAt, linesToText, type OcrLine } from './logic'

/** 本工具 id（与 registry 一致） */
const TOOL_ID = 'ocr'
/** 本工具的 AI 目录：模型状态只读（下载、删除、校验都在 AI 中心） */
const catalog = useAiCatalog(TOOL_ID)
/** 提供者是否已探测过；探测前不提示“无可用模型”，免得闪一下 */
const catalogReady = catalog.ready
/** 所选文字识别模型是否已安装 */
const modelReady = computed(() => catalog.current.value?.status === 'ready')

/** 已选图片 */
const image = shallowRef<PickedImage | null>(null)
/** 识别中 */
const busy = ref(false)
/** 识别结果 */
const result = shallowRef<OcrResult | null>(null)
/** 当前高亮的行，-1 为无 */
const active = ref(-1)
/** 当前识别的取消控制器 */
let controller: AbortController | null = null
/** 预览容器，用于把点击换算回原图坐标 */
const stage = ref<HTMLElement | null>(null)

/** 按阅读顺序排好的行 */
const lines = computed<OcrLine[]>(() => (result.value ? groupLines(result.value.blocks) : []))
/** 全文 */
const fullText = computed(() => linesToText(lines.value))
/** 结果摘要 */
const summary = computed(() => {
  const r = result.value
  if (!r) return ''
  return `${lines.value.length} 行 · 平均置信度 ${Math.round(averageScore(r.blocks) * 100)}% · 用时 ${r.elapsedMs} ms`
})
/** 叠加层坐标系（原图尺寸，结果里没有时用选图时探测到的） */
const viewBox = computed(() => {
  const w = result.value?.width || image.value?.width || 1
  const h = result.value?.height || image.value?.height || 1
  return `0 0 ${w} ${h}`
})
/** 要画的框：每个框带所属行号 */
const boxes = computed(() => {
  const out: Array<{ points: string; line: number }> = []
  lines.value.forEach((l, i) => l.blocks.forEach((b) => out.push({ points: boxPoints(b.box), line: i })))
  return out
})

/** 采用新图：释放旧图，换图后清掉旧结果 */
function adopt(img: PickedImage): void {
  image.value?.release()
  image.value = img
  result.value = null
  active.value = -1
}

/** 相册选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ edit: EDIT_BASIC, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got.length) adopt(got[0])
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照 */
async function shoot(): Promise<void> {
  const got = await shootPhoto()
  if (got) adopt(got)
}

/** 开始识别 */
async function run(): Promise<void> {
  if (!image.value || busy.value) return
  busy.value = true
  controller = new AbortController()
  try {
    const path = await resolveImagePath(image.value)
    result.value = await aiOcr(path, controller.signal)
    active.value = -1
    if (!result.value.blocks.length) showToast('没有识别到文字')
  } catch (e) {
    if (isAiCancelled(e)) return
    // 撞上“模型未就绪”：重新探测目录，提示条随之出现；状态仍显示可用时给一句通用提示
    if (e instanceof AiNotReadyError) await handleNotReady(catalog.refresh, () => catalog.current.value?.status === 'ready', showToast)
    else showToast(aiErrorText(e))
  } finally {
    controller = null
    busy.value = false
  }
}

/** 复制文本并提示 */
async function copy(text: string, tip: string): Promise<void> {
  showToast((await copyText(text)) ? tip : '复制失败，请手动长按选择')
}

/** 点击图片：命中某个框则高亮并滚动到对应行 */
function onStageClick(ev: MouseEvent): void {
  const el = stage.value
  const r = result.value
  if (!el || !r) return
  const rect = el.getBoundingClientRect()
  if (!rect.width) return
  const k = (r.width || 1) / rect.width
  active.value = lineIndexAt(lines.value, (ev.clientX - rect.left) * k, (ev.clientY - rect.top) * k)
}

/** 离开页面：取消还在跑的识别，释放图片 */
function cleanup(): void {
  controller?.abort()
  image.value?.release()
}

onDeactivated(() => controller?.abort())
onBeforeUnmount(cleanup)
</script>

<template>
  <div class="tool-page">
    <tool-group title="选择图片">
      <div v-if="image" ref="stage" class="stage" @click="onStageClick">
        <img class="stage__img" :src="image.url" alt="待识别图片" />
        <svg v-if="result" class="stage__mask" :viewBox="viewBox" preserveAspectRatio="none">
          <polygon v-for="(b, i) in boxes" :key="i" :points="b.points" class="box" :class="{ 'is-active': b.line === active }" />
        </svg>
      </div>
      <p v-else class="tool-hint">点底部「相册」或「拍照」选一张图。</p>
      <p class="tool-hint">中文、英文、数字由同一个模型一起识别。</p>
    </tool-group>

    <model-missing-notice v-if="catalogReady && !modelReady" />

    <tool-group v-if="result" title="识别结果">
      <p class="tool-hint">{{ summary }}。点图上的框或下面的行可以定位，点行即复制该行。</p>
      <ul v-if="lines.length" class="lines">
        <li v-for="(l, i) in lines" :key="i" class="line" :class="{ 'is-active': i === active }" @click="active = i; copy(l.text, '已复制该行')">
          {{ l.text }}
        </li>
      </ul>
    </tool-group>

    <!-- 底部动作栏：相册 / 拍照选图，复制全文，主按钮开始识别 -->
    <bottom-actions :actions="{ copy: { disabled: !lines.length, text: '复制全文' } }" album photo main :main-text="busy ? '识别中' : '开始识别'" :disabled="{ album: busy, photo: busy, main: busy || !image || !modelReady }" @album="choose" @photo="shoot" @main="run" @copy="copy(fullText, '已复制全文')" />
  </div>
</template>

<style lang="scss" scoped>
/* 预览容器：图自适应宽度，叠加层铺满 */
.stage {
  position: relative;
  margin-bottom: $space-3;
  line-height: 0;

  &__img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 8px;
  }

  &__mask {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
}

/* 识别框 */
.box {
  fill: transparent;
  stroke: var(--c-primary);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;

  &.is-active {
    fill: rgba(59, 108, 246, 0.25);
    stroke: var(--c-error);
  }
}

.lines {
  margin: 0 0 $space-3;
  padding: 0;
  list-style: none;
}

.line {
  padding: $space-2 $space-3;
  border-bottom: 1px solid var(--c-border);
  font-size: 14px;
  line-height: 1.5;
  word-break: break-all;

  &.is-active {
    background: var(--c-surface-active);
  }
}
</style>
