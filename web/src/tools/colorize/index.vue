<script setup lang="ts">
// 黑白上色：选一张黑白照片 → 本地模型上色 → 结果展示/保存
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { fitMaxEdge, outputName } from '@/shared/image-calc'
import { drawScaled, loadBitmap, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'
import { aiColorize, AiNotReadyError, fetchAiResult } from '@/native/ai'
import AiGapNotice from '@/tools/_ai/AiGapNotice.vue'
import { useAiModel } from '@/tools/_ai/useAiModel'
import { aiErrorText, resolveImagePath } from '@/tools/_ai/aiImage'
import { isColorful, validateColorize } from './logic'

/** 检测是否已有颜色用的缩略图最长边 */
const PROBE_EDGE = 64
/** 输出文件名后缀 */
const NAME_SUFFIX = '_color'

/** 模型状态 */
const { ready, checked, loading: checking, refresh, markNotReady } = useAiModel('colorize')
/** 结果与处理状态 */
const { results, busy, saving, process, saveAll, clear } = useImageResults()

/** 已选图片 */
const image = shallowRef<PickedImage | null>(null)
/** 这张图是否已经有颜色 */
const colorful = ref(false)

/** 校验提示 */
const problem = computed(() => validateColorize(image.value && { url: image.value.url, width: image.value.width, height: image.value.height }))

/** 探测图片是否已有颜色（失败不影响使用） */
async function probe(img: PickedImage): Promise<void> {
  try {
    const bmp = await loadBitmap(img)
    const fit = fitMaxEdge(bmp.width, bmp.height, PROBE_EDGE)
    const small = drawScaled(bmp, fit.width, fit.height)
    bmp.close()
    const data = small.getContext('2d')!.getImageData(0, 0, small.width, small.height).data
    releaseCanvas(small)
    colorful.value = isColorful(data)
  } catch {
    colorful.value = false
  }
}

/** 选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got.length) return
    image.value?.release()
    image.value = got[0]
    colorful.value = false
    clear()
    void probe(got[0])
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 开始上色 */
async function run(): Promise<void> {
  const img = image.value
  if (problem.value || !img) {
    if (problem.value) showToast(problem.value)
    return
  }
  await process([0], async () => {
    try {
      const res = await aiColorize(await resolveImagePath(img))
      const blob = await fetchAiResult(res.path)
      const bmp = await createImageBitmap(blob)
      const { width, height } = bmp
      bmp.close()
      return { name: outputName(img.name, blob.type || 'image/png', NAME_SUFFIX), blob, width, height }
    } catch (e) {
      // process 会吞掉错误，这里先给出明确提示
      if (e instanceof AiNotReadyError) {
        markNotReady()
        showToast(e.message)
      } else {
        showToast(aiErrorText(e))
      }
      throw e
    }
  })
}

onBeforeUnmount(() => image.value?.release())
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">选择黑白照片</h3>
      <img v-if="image" class="preview" :src="image.url" alt="待上色照片" />
      <van-button block plain round :disabled="busy" @click="choose">{{ image ? '换一张' : '选择图片' }}</van-button>
      <p v-if="colorful" class="tool-hint">这张图看起来已经有颜色了，上色可能没什么变化。</p>
      <p class="tool-hint">上色是模型的「合理猜测」，衣服、肤色等不一定和实物一致。</p>
    </div>

    <ai-gap-notice v-if="checked && !ready" feature="黑白上色" purpose="给黑白照片自动填色" retry :loading="checking" @retry="refresh" />

    <van-button type="primary" block round :loading="busy" :disabled="!!problem || !ready" @click="run">
      {{ busy ? '上色中，请稍等…' : '开始上色' }}
    </van-button>

    <div v-if="results.length" class="tool-card">
      <h3 class="tool-card__title">结果（点击预览）</h3>
      <image-result-list :results="results" />
      <van-button type="primary" plain block round :loading="saving" @click="saveAll">保存</van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.preview {
  display: block;
  width: 100%;
  max-height: 50vh;
  margin-bottom: $space-3;
  object-fit: contain;
  border-radius: 8px;
}
</style>
