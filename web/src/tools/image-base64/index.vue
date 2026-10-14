<script setup lang="ts">
// 图片转 Base64：选图出 data URL / 纯 Base64；也能粘贴 Base64 还原图片并保存
import { computed, onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { formatBytes, mimeToExt } from '@/shared/image-calc'
import { pickImages, saveBlob, type PickedImage } from '@/shared/image-io'
import {
  base64ToBytes,
  bloatText,
  BIG_TEXT_CHARS,
  buildDataUrl,
  LARGE_BYTES,
  parseBase64Input,
  sniffImageMime,
  stripDataUrlPrefix,
} from './logic'

/** 文本框里最多显示的字符数，超出只显示开头，复制仍是完整内容 */
const SHOW_CHARS = 2000
/** 还原图的文件名前缀 */
const NAME_PREFIX = 'base64'

/** 当前模式：encode 图转文本，decode 文本转图 */
const mode = ref<'encode' | 'decode'>('encode')

/** 已选图片 */
const image = ref<PickedImage | null>(null)
/** 完整 data URL */
const dataUrl = ref('')
/** 是否带 data: 前缀输出 */
const withPrefix = ref(true)
/** 编码中 */
const encoding = ref(false)

/** 当前输出的完整文本 */
const output = computed(() => (withPrefix.value ? dataUrl.value : stripDataUrlPrefix(dataUrl.value)))
/** 文本框里显示的内容（截断） */
const shown = computed(() => (output.value.length > SHOW_CHARS ? `${output.value.slice(0, SHOW_CHARS)}……` : output.value))
/** 体积与膨胀率说明 */
const sizeInfo = computed(() => {
  const img = image.value
  if (!img || !output.value) return ''
  return `原图 ${formatBytes(img.size)} → 文本 ${formatBytes(output.value.length)}（${bloatText(img.size, output.value.length)}）`
})

/** 选图并编码 */
async function choose(): Promise<void> {
  try {
    const [got] = await pickImages({ multiple: false, max: 1, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got) return
    image.value?.release()
    image.value = got
    dataUrl.value = ''
    if (got.size > LARGE_BYTES) showToast(`图片有 ${formatBytes(got.size)}，编码会比较慢，文本也很长`)
    encoding.value = true
    dataUrl.value = await blobToDataUrl(await (await fetch(got.url)).blob())
  } catch (e) {
    showFailToast((e as { message?: string }).message ?? '编码失败')
  } finally {
    encoding.value = false
  }
}

/** Blob 转 data URL */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

/** 复制输出，长文本给提示 */
async function copy(): Promise<void> {
  if (!output.value) return
  if (await copyText(output.value)) {
    showSuccessToast('已复制')
    if (output.value.length > BIG_TEXT_CHARS) showToast('文本很长，如粘贴不全，请改用保存图片')
  } else {
    showFailToast('复制失败')
  }
}

/** 粘贴框内容 */
const pasted = ref('')
/** 还原出的图片 */
const restored = ref<{ blob: Blob; url: string; mime: string } | null>(null)
/** 还原错误提示 */
const restoreError = ref('')

/** 回收还原图的 ObjectURL */
function dropRestored(): void {
  if (restored.value) URL.revokeObjectURL(restored.value.url)
  restored.value = null
}

/** 从剪贴板读取（可能无权限，失败只提示） */
async function paste(): Promise<void> {
  try {
    pasted.value = await navigator.clipboard.readText()
    restore()
  } catch {
    showToast('读取剪贴板失败，请长按输入框手动粘贴')
  }
}

/** 解析粘贴内容并还原预览 */
function restore(): void {
  dropRestored()
  restoreError.value = ''
  if (!pasted.value.trim()) return
  const parsed = parseBase64Input(pasted.value)
  if (!parsed) {
    restoreError.value = '不是有效的 Base64 或 data URL'
    return
  }
  const bytes = base64ToBytes(parsed.base64)
  const mime = sniffImageMime(bytes) || (parsed.mime.startsWith('image/') ? parsed.mime : '')
  if (!mime) {
    restoreError.value = '解码成功，但看起来不是图片'
    return
  }
  const blob = new Blob([bytes], { type: mime })
  restored.value = { blob, url: URL.createObjectURL(blob), mime }
}

/** 保存还原出的图片 */
async function saveRestored(): Promise<void> {
  const r = restored.value
  if (!r) return
  try {
    const res = await saveBlob(r.blob, `${NAME_PREFIX}_${Date.now()}.${mimeToExt(r.mime)}`)
    showSuccessToast(res.mode === 'native' ? '已保存到相册' : '已下载')
  } catch (e) {
    showFailToast((e as { message?: string }).message ?? '保存失败')
  }
}

/** 重置粘贴区 */
function clearPaste(): void {
  pasted.value = ''
  restoreError.value = ''
  dropRestored()
}

onBeforeUnmount(() => {
  image.value?.release()
  dropRestored()
})
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="mode" type="card">
      <van-tab title="图片转文本" name="encode" />
      <van-tab title="文本转图片" name="decode" />
    </van-tabs>

    <template v-if="mode === 'encode'">
      <div class="tool-card">
        <h3 class="tool-card__title">选择图片</h3>
        <img v-if="image" class="b64-thumb" :src="image.url" alt="已选图片" />
        <van-button block plain round :loading="encoding" @click="choose">{{ image ? '换一张' : '选择图片' }}</van-button>
      </div>

      <van-cell-group inset>
        <van-cell title="带 data:image 前缀" center>
          <template #right-icon><van-switch v-model="withPrefix" size="22" /></template>
        </van-cell>
      </van-cell-group>

      <div class="tool-card">
        <h3 class="tool-card__title">结果</h3>
        <van-field :model-value="shown" type="textarea" rows="4" autosize readonly placeholder="选图后这里显示 Base64" />
        <p v-if="sizeInfo" class="tool-hint">{{ sizeInfo }}</p>
        <p v-if="output.length > SHOW_CHARS" class="tool-hint">文本较长，这里只显示开头，复制的是完整内容。</p>
        <p v-if="output.length > BIG_TEXT_CHARS" class="tool-hint b64-warn">超过 500KB，部分应用粘贴会被截断。</p>
      </div>

      <van-button type="primary" block round :disabled="!output" @click="copy">复制</van-button>
    </template>

    <template v-else>
      <div class="tool-card">
        <h3 class="tool-card__title">粘贴 Base64 或 data URL</h3>
        <van-field
          v-model="pasted"
          type="textarea"
          rows="4"
          autosize
          clearable
          placeholder="data:image/png;base64,... 或纯 Base64"
          :error-message="restoreError"
          @update:model-value="restore"
        />
        <div class="tool-actions b64-bar">
          <van-button size="small" plain icon="records-o" @click="paste">从剪贴板粘贴</van-button>
          <van-button size="small" plain icon="delete-o" @click="clearPaste">清空</van-button>
        </div>
      </div>

      <div v-if="restored" class="tool-card">
        <h3 class="tool-card__title">预览（{{ formatBytes(restored.blob.size) }}）</h3>
        <img class="b64-thumb" :src="restored.url" alt="还原的图片" />
        <van-button type="primary" block round @click="saveRestored">保存图片</van-button>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
/* 预览图：限高居中，棋盘感由 surface 底色代替 */
.b64-thumb {
  display: block;
  max-width: 100%;
  max-height: 220px;
  margin: 0 auto $space-3;
  border-radius: 6px;
  background: var(--c-surface-active);
}

.b64-bar {
  margin-top: $space-2;
}

/* 过长提示 */
.b64-warn {
  color: var(--c-error);
}
</style>
