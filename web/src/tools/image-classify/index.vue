<script setup lang="ts">
// AI 图像识别：选图 → 本地分类 → top-K 条形展示（中文标签表在原生侧）
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import { pickImages, type PickedImage } from '@/shared/image-io'
import { aiClassify, AiNotReadyError, type ClassifyItem } from '@/native/ai'
import AiGapNotice from '@/tools/_ai/AiGapNotice.vue'
import { useAiModel } from '@/tools/_ai/useAiModel'
import { aiErrorText, resolveImagePath } from '@/tools/_ai/aiImage'
import { DEFAULT_TOP_K, normalizeItems, toRows, TOP_K_OPTIONS } from './logic'

/** 模型状态 */
const { ready, checked, loading: checking, refresh, markNotReady } = useAiModel('classify')

/** 已选图片 */
const image = shallowRef<PickedImage | null>(null)
/** 返回条数 */
const topK = ref(DEFAULT_TOP_K)
/** 识别中 */
const busy = ref(false)
/** 识别结果，null 表示还没识别 */
const items = shallowRef<ClassifyItem[] | null>(null)

/** 展示行 */
const rows = computed(() => (items.value ? toRows(normalizeItems(items.value, topK.value)) : []))

/** 选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got.length) return
    image.value?.release()
    image.value = got[0]
    items.value = null
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
    items.value = (await aiClassify(path, topK.value)).items
  } catch (e) {
    if (e instanceof AiNotReadyError) markNotReady()
    else showToast(aiErrorText(e))
  } finally {
    busy.value = false
  }
}

onBeforeUnmount(() => image.value?.release())
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">选择图片</h3>
      <img v-if="image" class="preview" :src="image.url" alt="待识别图片" />
      <van-button block plain round :disabled="busy" @click="choose">{{ image ? '换一张' : '选择图片' }}</van-button>
      <van-cell title="显示前几名" center>
        <template #value>
          <van-radio-group v-model="topK" direction="horizontal" class="is-radios">
            <van-radio v-for="k in TOP_K_OPTIONS" :key="k" :name="k">{{ k }}</van-radio>
          </van-radio-group>
        </template>
      </van-cell>
    </div>

    <ai-gap-notice v-if="checked && !ready" feature="图像识别" purpose="判断图里是什么东西" retry :loading="checking" @retry="refresh" />

    <van-button type="primary" block round :loading="busy" :disabled="!image || !ready" @click="run">
      {{ busy ? '识别中…' : '开始识别' }}
    </van-button>

    <div v-if="items" class="tool-card">
      <h3 class="tool-card__title">识别结果</h3>
      <p v-if="!rows.length" class="tool-hint">没有得到可信的结果，换一张更清晰的图试试。</p>
      <ul v-else class="rows">
        <li v-for="(r, i) in rows" :key="i" class="row">
          <div class="row__head">
            <span class="row__label">{{ r.label }}</span>
            <span class="row__pct">{{ r.percent }}</span>
          </div>
          <div class="row__track"><div class="row__bar" :style="{ width: r.bar + '%' }" /></div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.is-radios {
  justify-content: flex-end;
}

.preview {
  display: block;
  width: 100%;
  max-height: 50vh;
  margin-bottom: $space-3;
  object-fit: contain;
  border-radius: 8px;
}

.rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  margin-bottom: $space-3;

  &__head {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
    font-size: 14px;
  }

  &__pct {
    color: var(--c-text-muted);
  }

  &__track {
    height: 8px;
    background: var(--c-surface-active);
    border-radius: 4px;
  }

  &__bar {
    height: 100%;
    background: var(--c-primary);
    border-radius: 4px;
  }
}
</style>
