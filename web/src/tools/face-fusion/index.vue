<script setup lang="ts">
// 人脸融合：选两张人脸照片 + 融合比例 → 本地模型融合 → 结果展示/保存
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { outputName } from '@/shared/image-calc'
import { pickImages, type PickedImage } from '@/shared/image-io'
import { aiFuse, AiNotReadyError, fetchAiResult } from '@/native/ai'
import AiGapNotice from '@/tools/_ai/AiGapNotice.vue'
import { useAiModel } from '@/tools/_ai/useAiModel'
import { aiErrorText, resolveImagePath } from '@/tools/_ai/aiImage'
import { DEFAULT_RATIO, RATIO_STEP, clampRatio, ratioText, validateFuse } from './logic'

/** 比例滑杆刻度：0~100 的整数 */
const SLIDER_MAX = 100
/** 输出文件名后缀 */
const NAME_SUFFIX = '_fusion'

/** 模型状态 */
const { ready, checked, loading: checking, refresh, markNotReady } = useAiModel('fuse')
/** 结果与处理状态 */
const { results, busy, saving, process, saveAll, clear } = useImageResults()

/** 图 A */
const imageA = shallowRef<PickedImage | null>(null)
/** 图 B */
const imageB = shallowRef<PickedImage | null>(null)
/** 融合比例（图 B 的占比） */
const ratio = ref(DEFAULT_RATIO)

/** 滑杆值（0~100），与比例互转 */
const sliderValue = computed({
  get: () => Math.round(ratio.value * SLIDER_MAX),
  set: (v: number) => {
    ratio.value = clampRatio(v / SLIDER_MAX)
  },
})
/** 校验提示，null 为可以开始 */
const problem = computed(() => validateFuse(imageA.value && { url: imageA.value.url, width: imageA.value.width, height: imageA.value.height }, imageB.value && { url: imageB.value.url, width: imageB.value.width, height: imageB.value.height }, ratio.value))

/** 为某一槽位选图 */
async function choose(slot: 'a' | 'b'): Promise<void> {
  try {
    const got = await pickImages({ onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got.length) return
    const ref_ = slot === 'a' ? imageA : imageB
    ref_.value?.release()
    ref_.value = got[0]
    clear()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 开始融合 */
async function run(): Promise<void> {
  const a = imageA.value
  const b = imageB.value
  if (problem.value || !a || !b) {
    if (problem.value) showToast(problem.value)
    return
  }
  await process([0], async () => {
    try {
      const res = await aiFuse(await resolveImagePath(a), await resolveImagePath(b), ratio.value)
      const blob = await fetchAiResult(res.path)
      const bmp = await createImageBitmap(blob)
      const { width, height } = bmp
      bmp.close()
      return { name: outputName(a.name, blob.type || 'image/png', NAME_SUFFIX), blob, width, height, note: ratioText(ratio.value) }
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

onBeforeUnmount(() => {
  imageA.value?.release()
  imageB.value?.release()
})
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">选择两张人脸照片</h3>
      <div class="pair">
        <div class="slot">
          <img v-if="imageA" class="slot__img" :src="imageA.url" alt="图 A" />
          <div v-else class="slot__empty">图 A</div>
          <van-button size="small" plain round :disabled="busy" @click="choose('a')">{{ imageA ? '更换' : '选图 A' }}</van-button>
        </div>
        <div class="slot">
          <img v-if="imageB" class="slot__img" :src="imageB.url" alt="图 B" />
          <div v-else class="slot__empty">图 B</div>
          <van-button size="small" plain round :disabled="busy" @click="choose('b')">{{ imageB ? '更换' : '选图 B' }}</van-button>
        </div>
      </div>
      <p class="tool-hint">正脸、光线均匀、五官清楚的照片效果更好。</p>
    </div>

    <div class="tool-card">
      <van-cell title="融合比例" :value="ratioText(ratio)" />
      <div class="is-slider"><van-slider v-model="sliderValue" :min="0" :max="SLIDER_MAX" :step="RATIO_STEP * SLIDER_MAX" /></div>
      <p class="tool-hint">越往右越像图 B。</p>
    </div>

    <ai-gap-notice v-if="checked && !ready" feature="人脸融合" purpose="检测两张脸并按比例合成" retry :loading="checking" @retry="refresh" />

    <van-button type="primary" block round :loading="busy" :disabled="!!problem || !ready" @click="run">
      {{ busy ? '融合中，请稍等…' : '开始融合' }}
    </van-button>
    <p v-if="problem" class="tool-hint">{{ problem }}</p>

    <div v-if="results.length" class="tool-card">
      <h3 class="tool-card__title">结果（点击预览）</h3>
      <image-result-list :results="results" />
      <van-button type="primary" plain block round :loading="saving" @click="saveAll">保存</van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 两个槽位并排 */
.pair {
  display: flex;
  gap: $space-3;
}

.slot {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: $space-2;
  align-items: center;

  &__img,
  &__empty {
    width: 100%;
    aspect-ratio: 3 / 4;
    border-radius: 8px;
  }

  &__img {
    object-fit: cover;
  }

  &__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--c-text-muted);
    background: var(--c-surface-active);
  }
}

.is-slider {
  padding: $space-2 $space-3 $space-3;
}
</style>
