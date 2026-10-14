<script setup lang="ts">
// 文字识别：选图 → 本地 OCR → 按阅读顺序排行 → 逐行/全文复制，识别框叠加在原图上
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { pickImages, type PickedImage } from '@/shared/image-io'
import { aiOcr, AiNotReadyError, type OcrResult } from '@/native/ai'
import AiGapNotice from '@/tools/_ai/AiGapNotice.vue'
import { useAiModel } from '@/tools/_ai/useAiModel'
import { aiErrorText, resolveImagePath } from '@/tools/_ai/aiImage'
import { boxPoints } from '@/tools/_ai/ocrBox'
import { averageScore, groupLines, lineIndexAt, linesToText, type OcrLine } from './logic'

/** 模型状态 */
const { ready, checked, loading: checking, refresh, markNotReady } = useAiModel('ocr')

/** 已选图片 */
const image = shallowRef<PickedImage | null>(null)
/** 识别语言 */
const lang = ref<'zh' | 'en'>('zh')
/** 识别中 */
const busy = ref(false)
/** 识别结果 */
const result = shallowRef<OcrResult | null>(null)
/** 当前高亮的行，-1 为无 */
const active = ref(-1)
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

/** 选图，换图后清掉旧结果 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got.length) return
    image.value?.release()
    image.value = got[0]
    result.value = null
    active.value = -1
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 开始识别 */
async function run(): Promise<void> {
  if (!image.value || busy.value) return
  busy.value = true
  try {
    const path = await resolveImagePath(image.value)
    result.value = await aiOcr(path, lang.value)
    active.value = -1
    if (!result.value.blocks.length) showToast('没有识别到文字')
  } catch (e) {
    if (e instanceof AiNotReadyError) markNotReady()
    else showToast(aiErrorText(e))
  } finally {
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

onBeforeUnmount(() => image.value?.release())
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">选择图片</h3>
      <div v-if="image" ref="stage" class="stage" @click="onStageClick">
        <img class="stage__img" :src="image.url" alt="待识别图片" />
        <svg v-if="result" class="stage__mask" :viewBox="viewBox" preserveAspectRatio="none">
          <polygon v-for="(b, i) in boxes" :key="i" :points="b.points" class="box" :class="{ 'is-active': b.line === active }" />
        </svg>
      </div>
      <van-button block plain round :disabled="busy" @click="choose">{{ image ? '换一张' : '选择图片' }}</van-button>
      <van-cell title="识别语言" center>
        <template #value>
          <van-radio-group v-model="lang" direction="horizontal" class="is-radios">
            <van-radio name="zh">中文（含英文数字）</van-radio>
            <van-radio name="en">英文</van-radio>
          </van-radio-group>
        </template>
      </van-cell>
    </div>

    <ai-gap-notice v-if="checked && !ready" feature="文字识别" purpose="检测并识别图中的文字" size="约 21MB" retry :loading="checking" @retry="refresh" />

    <van-button type="primary" block round :loading="busy" :disabled="!image || !ready" @click="run">
      {{ busy ? '识别中…' : '开始识别' }}
    </van-button>

    <div v-if="result" class="tool-card">
      <h3 class="tool-card__title">识别结果</h3>
      <p class="tool-hint">{{ summary }}。点图上的框或下面的行可以定位，点行即复制该行。</p>
      <ul v-if="lines.length" class="lines">
        <li v-for="(l, i) in lines" :key="i" class="line" :class="{ 'is-active': i === active }" @click="active = i; copy(l.text, '已复制该行')">
          {{ l.text }}
        </li>
      </ul>
      <van-button v-if="lines.length" type="primary" plain block round @click="copy(fullText, '已复制全文')">复制全文</van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.is-radios {
  justify-content: flex-end;
}

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
