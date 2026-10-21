<script setup lang="ts">
// B 站封面获取：输入 BV / av / 视频链接 / b23.tv 短链，预览并保存封面
import BottomActions from '@/shared/BottomActions.vue'
import { onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { saveBlob } from '@/shared/image-io'
import { coverFileName, fetchCover, type VideoInfo } from './logic'

/** 是否在 App 内 */
const inApp = isNativeAvailable()
/** 输入 */
const input = ref('')
/** 获取中 */
const loading = ref(false)
/** 错误提示 */
const error = ref('')
/** 视频信息 */
const info = ref<VideoInfo | null>(null)
/** 封面预览地址（ObjectURL） */
const previewUrl = ref('')
/** 封面内容 */
let coverBlob: Blob | null = null
/** 封面类型 */
let coverType = ''
/** 当前请求的取消器 */
let ac: AbortController | null = null

/** 释放当前预览地址 */
function revokePreview(): void {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
}

/** 获取封面；进行中再点等于取消 */
async function run(): Promise<void> {
  if (loading.value) {
    ac?.abort()
    return
  }
  if (!input.value.trim()) {
    error.value = '请输入 BV 号、av 号、视频链接或短链'
    return
  }
  error.value = ''
  info.value = null
  coverBlob = null
  revokePreview()
  loading.value = true
  const mine = new AbortController()
  ac = mine
  try {
    const r = await fetchCover(input.value, undefined, mine.signal)
    if (ac !== mine) return
    info.value = r.info
    coverBlob = r.blob
    coverType = r.contentType
    previewUrl.value = URL.createObjectURL(r.blob)
  } catch (e) {
    if (ac === mine) error.value = mine.signal.aborted ? '已取消' : (e as { message?: string }).message || '获取失败'
  } finally {
    if (ac === mine) {
      loading.value = false
      ac = null
    }
  }
}

/** 保存封面 */
async function save(): Promise<void> {
  if (!coverBlob || !info.value) return
  try {
    await saveBlob(coverBlob, coverFileName(info.value, coverType))
    showSuccessToast('已保存')
  } catch {
    showFailToast('保存失败')
  }
}

onBeforeUnmount(() => {
  const cur = ac
  ac = null
  cur?.abort()
  revokePreview()
})
</script>

<template>
  <div class="tool-page">
    <tool-group v-if="!inApp">
      <p class="tool-hint">需要在 App 内使用：请求由 App 原生发出，浏览器里没法直接联网。</p>
    </tool-group>

    <tool-group title="视频">
      <van-field v-model="input" type="textarea" rows="2" autosize clearable placeholder="BV 号、av 号、视频链接，或 b23.tv 短链" :disabled="!inApp" />
      <p v-if="error" class="tool-hint bc-error">{{ error }}</p>
      <p class="tool-hint">封面来自 B 站公开接口，版权归原作者，请合理使用。</p>
    </tool-group>

    <tool-group v-if="info && previewUrl" :title="`${info.title || '封面'}`">
      <p v-if="info.owner" class="tool-hint">UP 主：{{ info.owner }}</p>
      <img :src="previewUrl" class="bc-img" alt="视频封面" />
    </tool-group>

    <!-- 底部动作栏：保存封面，主按钮获取封面（获取中变成取消） -->
    <bottom-actions :main-loading="loading" :actions="{ save: { disabled: !previewUrl, text: '保存封面' } }" main :main-text="loading ? '取消' : '获取封面'" :main-type="loading ? 'danger' : 'primary'" :disabled="{ main: !inApp }" @main="run" @save="save" />
  </div>
</template>

<style lang="scss" scoped>
.bc-error {
  color: var(--c-error);
}
.bc-img {
  display: block;
  width: 100%;
  margin-top: $space-2;
  border-radius: 8px;
}
</style>
