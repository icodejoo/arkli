<script setup lang="ts">
// 以图搜图：选图后可分享/保存图片，并打开或复制各搜图站入口；不替你上传，也不泄漏图片内容
import { onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { pickImages, type PickedImage } from '@/shared/image-io'
import { NOTES, SEARCH_SITES, STEPS } from './data'
import { openSite, shareImage, shareName } from './logic'

/** 当前图片 */
const image = ref<PickedImage | null>(null)
/** 处理中 */
const busy = ref(false)

/** 选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ multiple: false, max: 1, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got.length) return
    image.value?.release()
    image.value = got[0]
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 分享图片，不行则保存 */
async function doShare(): Promise<void> {
  const img = image.value
  if (!img || busy.value) return
  busy.value = true
  try {
    const blob = await (await fetch(img.url)).blob()
    const r = await shareImage(blob, shareName(img.name, img.mime || blob.type))
    if (r === 'saved') showSuccessToast('已保存，请到相册里选这张图')
  } catch {
    showFailToast('分享失败，请重试')
  } finally {
    busy.value = false
  }
}

/** 打开站点 */
async function open(url: string): Promise<void> {
  if (!(await openSite(url))) showFailToast('无法打开该链接')
}

/** 复制站点链接 */
async function copyLink(url: string): Promise<void> {
  if (await copyText(url)) showSuccessToast('链接已复制')
  else showFailToast('复制失败，请手动长按选择')
}

onBeforeUnmount(() => image.value?.release())
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">怎么用</h3>
      <p v-for="(s, i) in STEPS" :key="s" class="tool-hint">{{ i + 1 }}. {{ s }}</p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">1. 选图并分享</h3>
      <img v-if="image" :src="image.url" class="is-thumb" alt="已选图片" />
      <div class="tool-actions">
        <van-button type="primary" @click="choose">{{ image ? '换一张' : '选择图片' }}</van-button>
        <van-button :disabled="!image" :loading="busy" @click="doShare">分享图片</van-button>
      </div>
      <p class="tool-hint">不支持分享时会自动保存到相册。</p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">2. 去搜图站</h3>
      <van-cell v-for="s in SEARCH_SITES" :key="s.url" :title="s.name" :label="s.note">
        <template #right-icon>
          <van-button size="mini" type="primary" @click="open(s.url)">打开</van-button>
          <van-button size="mini" class="is-gap" @click="copyLink(s.url)">复制链接</van-button>
        </template>
      </van-cell>
      <p v-for="n in NOTES" :key="n" class="tool-hint">{{ n }}</p>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 已选图缩略图 */
.is-thumb {
  display: block;
  max-width: 100%;
  max-height: 220px;
  margin: 0 auto $space-3;
  border-radius: 4px;
}
.is-gap {
  margin-left: $space-2;
}
</style>
