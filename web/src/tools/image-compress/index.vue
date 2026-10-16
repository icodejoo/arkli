<script setup lang="ts">
// 图片压缩（含格式转换）：JPEG / WebP / PNG，质量、最长边、目标体积、PNG 缩色。
// App 内走原生 native.image.compress；桌面浏览器没有宿主时退回 Canvas，两条路径共用界面与结果列表。
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, reactive, ref, shallowRef } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import ImageThumbList from '@/shared/ImageThumbList.vue'
import { shootPhoto } from '@/shared/shootPhoto'
import { changeText, fitMaxEdge, FORMAT_MIME, formatBytes, outputName } from '@/shared/image-calc'
import {
  canvasToBlob,
  drawScaled,
  loadBitmap,
  pickImages,
  releaseCanvas,
  saveBlobs,
  webpEncodeSupported,
  type PickedImage,
} from '@/shared/image-io'
import { isNativeAvailable } from '@/native/bridge'
import { useNative } from '@/native/useNative'
import {
  buildParams,
  capabilities,
  COLORS_MAX,
  COLORS_MIN,
  defaultOptions,
  describeFailed,
  EDGE_PRESETS,
  isBigger,
  PALETTE_HINT,
  progressText,
  QUALITY_MAX,
  QUALITY_MIN,
  resultNote,
  roomLeft,
  type NativeFailed,
  type NativeItem,
} from './logic'

/** 单次最多选择张数 */
const MAX_PICK = 20
/** 输出文件名后缀（Canvas 路径用） */
const NAME_SUFFIX = '-min'
/** 缓存路径在页面里的同源前缀 */
const FILES_URL_PREFIX = '/files/'
/** 取消错误码 */
const CODE_CANCELLED = 'CANCELLED'
/** JPEG 透明区底色 */
const JPEG_FILL = '#ffffff'

/** 一条结果（原生与 Canvas 共用） */
interface Row {
  /** 列表 key */
  id: number
  /** 保存名 */
  name: string
  /** 缩略图地址 */
  url: string
  /** 宽 */
  width: number
  /** 高 */
  height: number
  /** 成品字节数 */
  bytes: number
  /** 原图字节数 */
  srcBytes: number
  /** MIME */
  mime: string
  /** 说明文案 */
  note: string
  /** 是否比原图大 */
  bigger: boolean
  /** 原生缓存路径（原生路径） */
  path?: string
  /** 内容（Canvas 路径） */
  blob?: Blob
}

/** 是否有原生宿主 */
const native = isNativeAvailable()
/** 原生调用、事件与取消 */
const { call, on, cancelAll } = useNative()
/** 已选图片 */
const images = ref<PickedImage[]>([])
/** 选项 */
const opts = reactive(defaultOptions())
/** 当前 WebView 能否编码 WebP（原生路径恒可） */
const webpOk = native || webpEncodeSupported()
/** 结果 */
const rows = shallowRef<Row[]>([])
/** 失败项 */
const failed = ref<string[]>([])
/** 是否处理中 */
const busy = ref(false)
/** 是否保存中 */
const saving = ref(false)
/** 进度文案 */
const progress = ref('')
/** Canvas 路径的取消标记 */
let cancelled = false
/** 自增编号 */
let seq = 0

/** 当前选项下的可用能力 */
const caps = computed(() => capabilities(native, opts.format))
/** 是否显示 PNG 缩色提示 */
const showPaletteHint = computed(() => opts.format === 'png' && opts.pngMode === 'palette')
/** 前后总体积对比 */
const summary = computed(() => {
  if (!rows.value.length) return ''
  const before = rows.value.reduce((s, r) => s + r.srcBytes, 0)
  const after = rows.value.reduce((s, r) => s + r.bytes, 0)
  return `${formatBytes(before)} → ${formatBytes(after)}（${changeText(before, after)}）`
})
/** 颜色数滑杆值（v-model 用数字） */
const colorsModel = computed({
  get: () => opts.colors,
  set: (v: number) => {
    opts.colors = v
  },
})

/** 回收 Canvas 路径的 ObjectURL 并清空结果 */
function clearResults(): void {
  rows.value.forEach((r) => {
    if (r.blob) URL.revokeObjectURL(r.url)
  })
  rows.value = []
  failed.value = []
}

/** 相册添加图片 */
async function add(): Promise<void> {
  const room = roomLeft(images.value.length, MAX_PICK)
  if (room <= 0) {
    showToast(`最多 ${MAX_PICK} 张`)
    return
  }
  try {
    const got = await pickImages({ multiple: true, max: room, onFailed: (f) => showToast(`${f.length} 张读取失败：${f[0].message}`) })
    images.value = images.value.concat(got)
    clearResults()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照添加一张 */
async function shoot(): Promise<void> {
  if (roomLeft(images.value.length, MAX_PICK) <= 0) {
    showToast(`最多 ${MAX_PICK} 张`)
    return
  }
  const got = await shootPhoto()
  if (!got) return
  images.value = images.value.concat(got)
  clearResults()
}

/** 底部主按钮：处理中点它取消，否则开始压缩 */
function onMain(): void {
  if (busy.value) cancel()
  else void run()
}

/** 移除第 i 张 */
function remove(i: number): void {
  images.value[i].release()
  images.value.splice(i, 1)
  clearResults()
}

/** 原生路径：整批交给 native.image.compress */
async function runNative(): Promise<void> {
  const inputs = images.value.map((i) => ({ path: i.path ?? '', name: i.name }))
  const off = on('image.progress', (d) => {
    const t = progressText(d)
    if (t) progress.value = t
  })
  try {
    const res = await call<{ items: NativeItem[]; failed: NativeFailed[] }>('native.image.compress', buildParams(inputs, opts), {
      timeoutMs: 0,
    })
    rows.value = res.items.map((r) => ({
      id: ++seq,
      name: r.name,
      url: FILES_URL_PREFIX + r.path,
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      srcBytes: r.srcBytes,
      mime: r.mime,
      note: resultNote(r.srcBytes, r.bytes, r.targetReached),
      bigger: isBigger(r.srcBytes, r.bytes) || r.targetReached === false,
      path: r.path,
    }))
    failed.value = res.failed.map(describeFailed)
  } catch (e) {
    const err = e as { code?: string; message?: string }
    if (err.code === CODE_CANCELLED) showToast('已取消')
    else showFailToast(err.message ? `压缩失败：${err.message}` : '压缩失败')
  } finally {
    off()
  }
}

/** Canvas 路径：逐张解码、缩放、toBlob */
async function runCanvas(): Promise<void> {
  const mime = FORMAT_MIME[!webpOk && opts.format === 'webp' ? 'png' : opts.format]
  const out: Row[] = []
  const errs: string[] = []
  for (let i = 0; i < images.value.length && !cancelled; i++) {
    const img = images.value[i]
    progress.value = `${i + 1}/${images.value.length}`
    let canvas: HTMLCanvasElement | null = null
    try {
      const bmp = await loadBitmap(img)
      try {
        const t = fitMaxEdge(bmp.width, bmp.height, opts.maxEdge)
        canvas = drawScaled(bmp, t.width, t.height, mime === FORMAT_MIME.jpeg ? JPEG_FILL : undefined)
        const blob = await canvasToBlob(canvas, mime, mime === FORMAT_MIME.png ? undefined : opts.quality / 100)
        out.push({
          id: ++seq,
          name: outputName(img.name, blob.type, NAME_SUFFIX),
          url: URL.createObjectURL(blob),
          width: t.width,
          height: t.height,
          bytes: blob.size,
          srcBytes: img.size,
          mime: blob.type,
          note: resultNote(img.size, blob.size),
          bigger: isBigger(img.size, blob.size),
          blob,
        })
      } finally {
        bmp.close()
      }
    } catch (e) {
      errs.push(`${img.name}：${(e as { message?: string }).message ?? '处理失败'}`)
    } finally {
      if (canvas) releaseCanvas(canvas)
    }
    rows.value = out.slice()
  }
  failed.value = errs
}

/** 开始压缩 */
async function run(): Promise<void> {
  if (busy.value || !images.value.length) return
  clearResults()
  busy.value = true
  cancelled = false
  progress.value = ''
  try {
    if (native) await runNative()
    else await runCanvas()
  } finally {
    busy.value = false
    progress.value = ''
  }
}

/** 取消处理中的任务 */
function cancel(): void {
  cancelled = true
  if (native) cancelAll()
}

/** 保存全部结果 */
async function save(): Promise<void> {
  if (saving.value || !rows.value.length) return
  saving.value = true
  try {
    if (native) {
      const res = await call<{ items: unknown[] }>(
        'native.file.save',
        { items: rows.value.map((r) => ({ path: r.path, name: r.name, mime: r.mime })) },
        { timeoutMs: 0 },
      )
      showSuccessToast(`已保存 ${res.items.length} 张到相册`)
    } else {
      const r = await saveBlobs(rows.value.map((x) => ({ name: x.name, blob: x.blob as Blob })))
      showSuccessToast(`已下载 ${r.saved} 张`)
    }
  } catch (e) {
    const msg = (e as { message?: string }).message
    showFailToast(msg ? `保存失败：${msg}` : '保存失败')
  } finally {
    saving.value = false
  }
}

onBeforeUnmount(() => {
  images.value.forEach((i) => i.release())
  clearResults()
})
</script>

<template>
  <div class="tool-page">
    <tool-group :title="`选择图片（最多 ${MAX_PICK} 张）`">
      <image-thumb-list :images="images" @remove="remove" />
      <p v-if="!images.length" class="tool-hint">点底部「相册」或「拍照」选图，可以多选。</p>
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <van-cell title="输出格式" center>
          <template #value>
            <van-radio-group v-model="opts.format" direction="horizontal" class="ic-radios">
              <van-radio name="jpeg">JPEG</van-radio>
              <van-radio name="webp" :disabled="!webpOk">WebP</van-radio>
              <van-radio name="png">PNG</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell v-if="opts.format !== 'png'" title="质量" :value="`${opts.quality}%`" />
      </van-cell-group>
      <div v-if="opts.format !== 'png'" class="ic-slider">
        <van-slider v-model="opts.quality" :min="QUALITY_MIN" :max="QUALITY_MAX" />
      </div>
      <van-cell-group :border="false">
        <van-cell title="最长边" center>
          <template #value>
            <van-radio-group v-model="opts.maxEdge" direction="horizontal" class="ic-radios">
              <van-radio v-for="e in EDGE_PRESETS" :key="e" :name="e">{{ e || '不限' }}</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <template v-if="opts.format !== 'png'">
          <van-cell title="目标体积" center :label="caps.target ? '' : '仅 App 内可用'">
            <template #value><van-switch v-model="opts.useTarget" size="22" :disabled="!caps.target" /></template>
          </van-cell>
          <van-field
            v-if="opts.useTarget && caps.target"
            v-model.number="opts.targetKb"
            type="number"
            label="不超过（KB）"
            input-align="right"
            placeholder="如 200"
          />
        </template>
        <template v-else>
          <van-cell title="PNG 模式" center :label="caps.pngPalette ? '' : '缩色仅 App 内可用'">
            <template #value>
              <van-radio-group v-model="opts.pngMode" direction="horizontal" class="ic-radios">
                <van-radio name="lossless">无损</van-radio>
                <van-radio name="palette" :disabled="!caps.pngPalette">缩色</van-radio>
              </van-radio-group>
            </template>
          </van-cell>
          <template v-if="opts.pngMode === 'palette'">
            <van-cell title="颜色数" :value="`${opts.colors}`" />
            <div class="ic-slider"><van-slider v-model="colorsModel" :min="COLORS_MIN" :max="COLORS_MAX" /></div>
            <van-cell title="抖动" center>
              <template #value><van-switch v-model="opts.dither" size="22" /></template>
            </van-cell>
          </template>
        </template>
        <van-cell v-if="opts.format === 'jpeg'" title="保留拍摄信息（EXIF）" center :label="caps.exif ? '' : '仅 App 内可用'">
          <template #value><van-switch v-model="opts.keepExif" size="22" :disabled="!caps.exif" /></template>
        </van-cell>
      </van-cell-group>
      <p v-if="showPaletteHint" class="tool-hint">{{ PALETTE_HINT }}</p>
      <p class="tool-hint">
        默认不带拍摄信息（含 GPS）；透明区域转 JPEG 时填白底。{{
          native ? '' : '当前是浏览器预览模式，缩色 PNG、目标体积、保留 EXIF 只在 App 内可用。'
        }}
      </p>
    </tool-group>

    <p v-if="busy" class="tool-hint">压缩中 {{ progress }}</p>

    <tool-group v-if="failed.length" :title="`失败 ${failed.length} 张`">
      <ul class="ic-failed">
        <li v-for="(f, i) in failed" :key="i">{{ f }}</li>
      </ul>
    </tool-group>

    <tool-group v-if="rows.length" :title="`结果 ${summary}`">
      <ul class="ic-results">
        <li v-for="r in rows" :key="r.id" class="ic-result">
          <img class="ic-result__img" :src="r.url" :alt="r.name" />
          <div class="ic-result__info">
            <div class="ic-result__name">{{ r.name }}</div>
            <div class="ic-result__meta">{{ r.width }}×{{ r.height }} · {{ formatBytes(r.bytes) }}</div>
            <div class="ic-result__note" :class="{ 'ic-result__note--warn': r.bigger }">{{ r.note }}</div>
          </div>
        </li>
      </ul>
    </tool-group>

    <!-- 底部动作栏：相册 / 拍照追加图片，保存全部结果，主按钮开始压缩（处理中变成取消） -->
    <bottom-actions
      album
      photo
      main
      :main-text="busy ? '取消' : '开始压缩'"
      :main-type="busy ? 'danger' : 'primary'"
      :disabled="{ album: busy, photo: busy, main: !busy && !images.length }"
      @album="add"
      @photo="shoot"
      @main="onMain"
      :actions="{ save: { disabled: !rows.length || saving, text: '保存全部' } }"
      @save="save"
    />
  </div>
</template>

<style lang="scss" scoped>
.ic-radios {
  justify-content: flex-end;
  row-gap: $space-2;
}

/* 滑杆留出触控空间 */
.ic-slider {
  padding: $space-2 $space-3 $space-3;
}

.ic-failed {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--c-danger, #ee0a24);
}

.ic-results {
  margin: 0 0 $space-3;
  padding: 0;
  list-style: none;
}

.ic-result {
  display: flex;
  align-items: center;
  gap: $space-3;
  padding: $space-2 0;
  border-bottom: 1px solid var(--c-border);

  &:last-child {
    border-bottom: 0;
  }
}

.ic-result__img {
  flex: none;
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--c-surface-active);
}

.ic-result__info {
  flex: 1;
  min-width: 0;
}

.ic-result__name {
  overflow: hidden;
  font-size: 14px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ic-result__meta {
  font-size: 12px;
  color: var(--c-text-muted);
}

/* 体积变化说明；变大或目标未达成时换警示色 */
.ic-result__note {
  font-size: 13px;
  font-weight: 500;
  color: var(--c-ok);

  &--warn {
    color: var(--c-warn, #ed6a0c);
  }
}
</style>
