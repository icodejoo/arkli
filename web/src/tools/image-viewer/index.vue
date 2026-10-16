<script setup lang="ts">
// 图片查看器：显示基础信息与 EXIF（相机参数、拍摄时间），GPS 默认折叠并提示隐私
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { showImagePreview, showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { pickImages, previewBlob, type PickedImage } from '@/shared/image-io'
import { shootPhoto } from '@/shared/shootPhoto'
import { parseExif, type ExifData } from './exif'
import { buildRows, detectKind, EXIF_READ_BYTES, formatGps, type ImageKind } from './logic'

/** 当前图片 */
const image = ref<PickedImage | null>(null)
/** 图片完整内容，供全屏预览复用 */
const blob = ref<Blob | null>(null)
/** 识别出的格式 */
const kind = ref<ImageKind>('unknown')
/** EXIF 解析结果 */
const exif = ref<ExifData | null>(null)
/** 是否展开 GPS */
const showGps = ref(false)
/** 是否读取中 */
const loading = ref(false)

/** 基础信息 + EXIF 展示行 */
const rows = computed(() =>
  image.value
    ? buildRows({ name: image.value.name, kind: kind.value, size: image.value.size, width: image.value.width, height: image.value.height }, exif.value)
    : [],
)
/** GPS 文案，没有则空串 */
const gpsText = computed(() => (exif.value?.gps ? formatGps(exif.value.gps) : ''))
/** 海拔文案 */
const altText = computed(() => (exif.value?.gps?.alt === undefined ? '' : `${Number(exif.value.gps.alt.toFixed(1))} m`))
/** 非 JPEG 或没有 EXIF 时的说明 */
const noExifHint = computed(() => {
  if (!image.value || exif.value) return ''
  return kind.value === 'jpeg' ? '这张图没有 EXIF 信息。' : '只有 JPEG 才读取 EXIF，其他格式仅显示基础信息。'
})

/** 采用新图并解析 */
async function adopt(img: PickedImage): Promise<void> {
  try {
    loading.value = true
    image.value?.release()
    image.value = img
    showGps.value = false
    const b = await (await fetch(img.url)).blob()
    blob.value = b
    const head = new Uint8Array(await b.slice(0, EXIF_READ_BYTES).arrayBuffer())
    kind.value = detectKind(head)
    exif.value = kind.value === 'jpeg' ? parseExif(head) : null
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  } finally {
    loading.value = false
  }
}

/** 相册选图并解析 */
async function choose(): Promise<void> {
  if (loading.value) return
  try {
    const got = await pickImages({ multiple: false, max: 1, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got.length) await adopt(got[0])
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照并解析 */
async function shoot(): Promise<void> {
  if (loading.value) return
  const got = await shootPhoto()
  if (got) await adopt(got)
}

/** 全屏预览：宿主内走原生，浏览器里回退 vant 预览 */
async function preview(): Promise<void> {
  const img = image.value
  if (!img) return
  try {
    if (blob.value && (await previewBlob(blob.value, img.name))) return
  } catch {
    // 原生预览失败时回退
  }
  showImagePreview({ images: [img.url], closeable: true })
}

/** 复制 GPS 坐标 */
async function copyGps(): Promise<void> {
  showToast((await copyText(gpsText.value)) ? '已复制坐标' : '复制失败')
}

onBeforeUnmount(() => image.value?.release())
</script>

<template>
  <div class="tool-page">
    <template v-if="image">
      <tool-group>
        <img class="shot" :src="image.url" :alt="image.name" @click="preview" />
        <p class="tool-hint">点击图片全屏查看</p>
      </tool-group>

      <tool-group title="图片信息">
        <van-cell-group :border="false">
          <van-cell v-for="r in rows" :key="r.label" :title="r.label" :value="r.value" />
        </van-cell-group>
        <p v-if="noExifHint" class="tool-hint">{{ noExifHint }}</p>
      </tool-group>

      <tool-group v-if="gpsText" title="拍摄位置">
        <template v-if="!showGps">
          <p class="tool-hint">这张图带着定位信息。分享前请留意，别把住址、公司位置带出去。</p>
          <van-button plain block round @click="showGps = true">显示 GPS 坐标</van-button>
        </template>
        <template v-else>
          <van-cell-group :border="false">
            <van-cell title="坐标" :value="gpsText" />
            <van-cell v-if="altText" title="海拔" :value="altText" />
          </van-cell-group>
          <div class="gps-actions">
            <van-button plain round size="small" @click="copyGps">复制坐标</van-button>
            <van-button plain round size="small" @click="showGps = false">隐藏</van-button>
          </div>
        </template>
      </tool-group>
    </template>
    <p v-else class="tool-hint">点底部「相册」或「拍照」选一张图，看看尺寸、相机参数和拍摄时间。全程在本机处理，不上传。</p>

    <!-- 底部动作栏：选图后自动解析，没有单独的开始按钮；右边主按钮是拍照 -->
    <bottom-actions album main main-text="拍照" main-type="danger" :disabled="{ album: loading, main: loading }" @album="choose" @main="shoot" />
  </div>
</template>

<style lang="scss" scoped>
/* 预览图限高，点击放大 */
.shot {
  display: block;
  width: 100%;
  max-height: 260px;
  object-fit: contain;
  border-radius: 8px;
  background: var(--c-surface-active);
}

/* GPS 操作按钮行 */
.gps-actions {
  display: flex;
  gap: $space-2;
  padding-top: $space-3;
}
</style>
