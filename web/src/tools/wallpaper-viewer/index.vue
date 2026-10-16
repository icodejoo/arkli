<script setup lang="ts">
// 获取壁纸：尽力读取系统壁纸并展示、预览、保存；Android 13+ 通常只能读到默认壁纸
import BottomActions from '@/shared/BottomActions.vue'
import { computed, ref } from 'vue'
import { showFailToast, showImagePreview, showSuccessToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { getWallpaper, wallpaperUrl, type WallpaperFail, type WallpaperOk } from '@/native/wallpaper'
import { previewBlob, saveBlob } from '@/shared/image-io'
import { ALTERNATIVE_TIP, describeFailure, describeOk, wallpaperFileName } from './logic'

/** 无宿主时的提示 */
const TIP_NO_HOST = '获取壁纸需要在 App 内使用。'
/** 版本限制说明，常驻显示 */
const TIP_LIMIT = 'Android 13 及以上出于隐私，系统通常只允许应用读到默认壁纸，甚至直接拒绝。'

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 读取中 */
const loading = ref(false)
/** 读到的壁纸 */
const ok = ref<WallpaperOk | null>(null)
/** 没读到的原因 */
const failed = ref<WallpaperFail | null>(null)
/** 保存中 */
const saving = ref(false)

/** 壁纸图片地址 */
const url = computed(() => (ok.value ? wallpaperUrl(ok.value.path) : ''))
/** 失败的中文说明 */
const failure = computed(() => (failed.value ? describeFailure(failed.value) : null))

/** 获取壁纸 */
async function onGet(): Promise<void> {
  if (loading.value) return
  loading.value = true
  ok.value = null
  failed.value = null
  try {
    const r = await getWallpaper()
    if (r.available) ok.value = r
    else failed.value = r
  } catch (e) {
    showFailToast((e as { message?: string }).message || '读取失败')
  } finally {
    loading.value = false
  }
}

/** 取壁纸文件内容 */
async function fetchBlob(): Promise<Blob> {
  const res = await fetch(url.value)
  if (!res.ok) throw new Error('读取壁纸文件失败')
  return res.blob()
}

/** 全屏预览：容器内走原生，否则退回 vant */
async function onPreview(): Promise<void> {
  if (!ok.value) return
  try {
    const blob = await fetchBlob()
    if (!(await previewBlob(blob, wallpaperFileName(ok.value.kind)))) showImagePreview({ images: [url.value] })
  } catch (e) {
    showFailToast((e as { message?: string }).message || '预览失败')
  }
}

/** 保存到相册 */
async function onSave(): Promise<void> {
  if (!ok.value || saving.value) return
  saving.value = true
  try {
    const res = await saveBlob(await fetchBlob(), wallpaperFileName(ok.value.kind))
    showSuccessToast(res.mode === 'native' ? '已保存到相册' : '已开始下载')
  } catch (e) {
    showFailToast((e as { message?: string }).message || '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrapable :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>

    <tool-group class="wv-main">
      <p class="tool-hint">{{ TIP_LIMIT }}</p>
    </tool-group>

    <tool-group v-if="ok">
      <div class="tool-group__title">{{ describeOk(ok) }}</div>
      <p v-if="ok.kind === 'default'" class="tool-hint">这是系统默认壁纸，不一定是你桌面正在用的那张。</p>
      <img class="wv-img" :src="url" alt="壁纸" @click="onPreview" />
    </tool-group>

    <tool-group v-if="failure">
      <div class="tool-group__title">{{ failure.title }}</div>
      <p class="tool-hint">{{ failure.detail }}</p>
      <p class="tool-hint">{{ ALTERNATIVE_TIP }}</p>
    </tool-group>

    <!-- 底部动作栏：预览与保存要先读到壁纸，主按钮读取壁纸 -->
    <bottom-actions main :main-text="loading ? '读取中' : '获取当前壁纸'" :disabled="{ main: loading || !hosted }" @main="onGet">
      <van-action-bar-icon icon="eye-o" text="预览" :disabled="!ok" @click="onPreview" />
      <van-action-bar-icon text="保存" :disabled="!ok || saving" @click="onSave"><template #icon><i-arkli-save /></template></van-action-bar-icon>
    </bottom-actions>
  </div>
</template>

<style lang="scss" scoped>
/* 读取按钮卡片 */
.wv-main {
  text-align: center;
}

/* 壁纸缩略展示，竖屏壁纸限制高度 */
.wv-img {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  margin: $space-3 auto;
  border-radius: 10px;
  object-fit: contain;
}
</style>
