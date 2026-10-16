<script setup lang="ts">
// 黑白上色：选一张黑白照片 → 本地模型上色 → 结果展示/保存
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { fitMaxEdge, outputName } from '@/shared/image-calc'
import { drawScaled, loadBitmap, EDIT_BASIC, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'
import { shootPhoto } from '@/shared/shootPhoto'
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

/** 采用新图：释放旧图、清掉旧结果并探测是否已有颜色 */
function adopt(img: PickedImage): void {
  image.value?.release()
  image.value = img
  colorful.value = false
  clear()
  void probe(img)
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
    <tool-group title="选择黑白照片">
      <img v-if="image" class="preview" :src="image.url" alt="待上色照片" />
      <p v-else class="tool-hint">点底部「相册」或「拍照」选一张黑白照片。</p>
      <p v-if="colorful" class="tool-hint">这张图看起来已经有颜色了，上色可能没什么变化。</p>
      <p class="tool-hint">上色是模型的「合理猜测」，衣服、肤色等不一定和实物一致。</p>
    </tool-group>

    <ai-gap-notice v-if="checked && !ready" feature="黑白上色" purpose="给黑白照片自动填色" retry :loading="checking" @retry="refresh" />

    <tool-group v-if="results.length" title="结果（点击预览）">
      <image-result-list :results="results" />
    </tool-group>

    <!-- 底部动作栏：相册 / 拍照选图，保存结果，主按钮开始上色 -->
    <bottom-actions :actions="{ save: { disabled: !results.length || saving } }" album photo main :main-text="busy ? '上色中' : '开始上色'" :disabled="{ album: busy, photo: busy, main: busy || !!problem || !image || !ready }" @album="choose" @photo="shoot" @main="run" @save="saveAll" />
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
