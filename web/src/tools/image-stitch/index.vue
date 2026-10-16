<script setup lang="ts">
// 图片拼接：纵/横拼，间距、背景色、对齐、统一宽/高，多图可排序。
// App 内走原生 native.image.stitch（成品留在缓存，页面只显示缩略图）并支持压缩、覆盖原图；
// 桌面浏览器没有宿主时退回 Canvas，作为兜底。
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from 'vant'
import ColorPicker from '@/shared/ColorPicker.vue'
import ImageThumbList from '@/shared/ImageThumbList.vue'
import ImageResultList from '@/shared/ImageResultList.vue'
import NativeResultList, { type NativeRow } from '@/shared/NativeResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { shootPhoto } from '@/shared/shootPhoto'
import { changeText, exceedsCanvas, FORMAT_MIME, stitchLayout, type StitchAlign, type StitchDirection } from '@/shared/image-calc'
import {
  canvasToBlob,
  createCanvas,
  discardOut,
  drawScaled,
  loadBitmap,
  overwriteOriginal,
  pickImages,
  releaseCanvas,
  type PickedImage,
} from '@/shared/image-io'
import { isNativeAvailable } from '@/native/bridge'
import { useNative } from '@/native/useNative'
import {
  buildParams,
  defaultOptions,
  QUALITY_DEFAULT,
  QUALITY_MAX,
  QUALITY_MIN,
  resultNote,
  type NativeFailed,
  type NativeItem,
} from '../image-compress/logic'
import {
  buildStitchParams,
  checkOverwrite,
  confirmText,
  DEFAULT_FORMAT,
  filesUrl,
  formatOfMime,
  GAP_MAX,
  JPEG_QUALITY,
  outputsToDiscard,
  overwriteErrorText,
  pngCompressMaxEdge,
  pngSlowHint,
  stitchPercent,
  type NativeStitchResult,
  type StitchFormat,
} from './logic'

/** 最多拼接张数 */
const MAX_PICK = 20
/** 默认背景色 */
const BG_DEFAULT = '#ffffff'
/** 输出文件名前缀 */
const NAME_PREFIX = 'stitch'
/** 列表行 key：拼接结果与压缩结果各一行 */
const ROW_ID_STITCH = 1
const ROW_ID_COMPRESS = 2
/** 取消错误码 */
const CODE_CANCELLED = 'CANCELLED'

/** 已选图片（顺序即拼接顺序） */
const images = ref<PickedImage[]>([])
/** 方向 */
const direction = ref<StitchDirection>('v')
/** 间距 */
const gap = ref(0)
/** 背景色 */
const bg = ref(BG_DEFAULT)
/** 对齐 */
const align = ref<StitchAlign>('center')
/** 是否统一宽/高 */
const unify = ref(true)
/** 输出格式：PNG 或 JPEG */
const format = ref<StitchFormat>(DEFAULT_FORMAT)
/** 结果与批处理状态（Canvas 兜底路径） */
const { results, busy, progress, saving, process, saveAll, clear: clearCanvas } = useImageResults()

/** 是否有原生宿主：有则选图保留原图句柄，拼接与压缩都走原生 */
const native = isNativeAvailable()
/** 原生调用、事件与取消 */
const { call, on, cancelAll } = useNative()
/** 原生拼接成品（含缩略图路径） */
const stitched = shallowRef<(NativeStitchResult & { mime: string }) | null>(null)
/** 原生压缩成品，保持与拼接成品相同格式 */
const compressed = shallowRef<(NativeItem & { thumbPath: string }) | null>(null)
/** 原生路径是否处理中（拼接或压缩） */
const nativeBusy = ref(false)
/** 原生路径进度文案，如 `37%`，压缩时为空 */
const nativeProgress = ref('')
/** 当前原生任务名，用于按钮文案 */
const nativeLabel = ref('处理中')
/** 是否保存中 */
const nativeSaving = ref(false)
/** 是否覆盖中 */
const overwriting = ref(false)
/** 压缩质量百分比，默认沿用图片压缩工具 */
const compressQuality = ref(QUALITY_DEFAULT)

/** 当前设置下的拼接布局（用已知宽高估算，不解码） */
const layout = computed(() =>
  stitchLayout(images.value.map((i) => ({ width: i.width, height: i.height })), {
    direction: direction.value,
    gap: gap.value,
    unify: unify.value,
    align: align.value,
  }),
)
/** 是否超出画布上限（原生路径有自己的像素上限，由原生报错，不在前端拦） */
const tooBig = computed(() => !native && layout.value.width > 0 && exceedsCanvas(layout.value.width, layout.value.height))
/** PNG 像素多时的提示 */
const slowHint = computed(() => pngSlowHint(format.value, layout.value.width, layout.value.height))
/** 统一宽/高的轴向文案 */
const unifyLabel = computed(() => (direction.value === 'v' ? '统一宽度' : '统一高度'))
/** 拼接结果列表行 */
const stitchRows = computed<NativeRow[]>(() => {
  const s = stitched.value
  return s ? [{ id: ROW_ID_STITCH, name: s.name, thumbUrl: filesUrl(s.thumbPath), path: s.path, width: s.width, height: s.height, size: s.size }] : []
})
/** 压缩结果列表行：缩略图沿用拼接缩略图（压缩成品可能很大，不直接当 img 解码） */
const compressRows = computed<NativeRow[]>(() => {
  const c = compressed.value
  const s = stitched.value
  if (!c || !s) return []
  const note = `相对拼接图 ${changeText(s.size, c.bytes)}（${resultNote(s.size, c.bytes)}）`
  return [{ id: ROW_ID_COMPRESS, name: c.name, thumbUrl: filesUrl(c.thumbPath), path: c.path, width: c.width, height: c.height, size: c.bytes, note }]
})
/** 成品的实际格式：有成品时以成品为准（出结果后用户可能又改了格式单选），否则取当前选择 */
const resultFormat = computed<StitchFormat>(() => formatOfMime(stitched.value?.mime) ?? format.value)
/** PNG 成品像素太多时，提醒压缩会先缩小尺寸 */
const pngShrinkHint = computed(() => {
  const s = stitched.value
  const edge = s ? pngCompressMaxEdge(resultFormat.value, s.width, s.height) : 0
  return edge ? `成品像素过多，压缩 PNG 时会先把最长边缩到 ${edge}px 以内` : ''
})
/** 当前第一张原图，覆盖原图的目标 */
const firstImage = computed(() => images.value[0])
/** 覆盖按钮预检：拼接与压缩成品格式相同，共用一份 */
const overwriteState = computed(() => checkOverwrite(firstImage.value, resultFormat.value))
/** 压缩滑杆是否有意义（PNG 无损，没有质量） */
const compressUsesQuality = computed(() => resultFormat.value === 'jpeg')

/** 丢弃本页全部原生产物并清空状态（旧拼接与旧压缩一起清，失败静默） */
function clearNative(): void {
  const paths = outputsToDiscard(stitched.value?.path, compressed.value?.path)
  stitched.value = null
  compressed.value = null
  if (paths.length) void discardOut(paths)
}

/** 清掉所有旧结果：Canvas 与原生两条路径都清 */
function clear(): void {
  clearCanvas()
  clearNative()
}

/** 相册添加图片 */
async function add(): Promise<void> {
  const room = MAX_PICK - images.value.length
  if (room <= 0) {
    showToast(`最多 ${MAX_PICK} 张`)
    return
  }
  try {
    const got = await pickImages({
      multiple: true,
      max: room,
      keepSource: true,
      onFailed: (f) => showToast(`${f.length} 张读取失败：${f[0].message}`),
    })
    images.value = images.value.concat(got)
    clear()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照添加一张 */
async function shoot(): Promise<void> {
  if (images.value.length >= MAX_PICK) {
    showToast(`最多 ${MAX_PICK} 张`)
    return
  }
  const got = await shootPhoto()
  if (!got) return
  images.value = images.value.concat(got)
  clear()
}

/** 移除第 i 张 */
function remove(i: number): void {
  if (nativeBusy.value) return
  images.value[i].release()
  images.value.splice(i, 1)
  clear()
}

/** 把第 i 张移动 delta 位 */
function move(i: number, delta: number): void {
  if (nativeBusy.value) return
  const j = i + delta
  if (j < 0 || j >= images.value.length) return
  const [it] = images.value.splice(i, 1)
  images.value.splice(j, 0, it)
  clear()
}

/** 原生拼接：整批交给 native.image.stitch，成品留在缓存，页面只拿路径与缩略图 */
async function runNative(): Promise<void> {
  if (nativeBusy.value) return
  clear()
  nativeBusy.value = true
  nativeLabel.value = '拼接中'
  nativeProgress.value = '0%'
  let pct = 0
  const off = on('image.progress', (d) => {
    pct = stitchPercent(d, pct)
    nativeProgress.value = `${pct}%`
  })
  try {
    const params = buildStitchParams(
      images.value.map((i) => i.path ?? ''),
      { direction: direction.value, gap: gap.value, bg: bg.value, align: align.value, unify: unify.value, format: format.value },
    )
    const res = await call<NativeStitchResult>('native.image.stitch', params, { timeoutMs: 0 })
    stitched.value = { ...res, mime: FORMAT_MIME[format.value] }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    if (err.code === CODE_CANCELLED) showToast('已取消')
    else showFailToast(err.message ? `拼接失败：${err.message}` : '拼接失败')
  } finally {
    off()
    nativeBusy.value = false
    nativeProgress.value = ''
  }
}

/** 取消处理中的原生任务 */
function cancelNative(): void {
  cancelAll()
}

/** 压缩拼接成品：保持格式不变，结果放在拼接结果下方；重压会先丢弃上一份 */
async function runCompress(): Promise<void> {
  const s = stitched.value
  if (!s || nativeBusy.value) return
  const old = compressed.value
  compressed.value = null
  if (old) void discardOut([old.path])
  nativeBusy.value = true
  nativeLabel.value = '压缩中'
  nativeProgress.value = ''
  try {
    // PNG 成品像素超过原生压缩上限时先按比例缩小，否则会报"过大"
    const o = {
      ...defaultOptions(),
      format: resultFormat.value,
      quality: compressQuality.value,
      maxEdge: pngCompressMaxEdge(resultFormat.value, s.width, s.height),
    }
    const res = await call<{ items: NativeItem[]; failed: NativeFailed[] }>(
      'native.image.compress',
      buildParams([{ path: s.path, name: s.name }], o),
      { timeoutMs: 0 },
    )
    if (res.items.length) compressed.value = { ...res.items[0], thumbPath: s.thumbPath }
    else showFailToast(res.failed[0]?.message ? `压缩失败：${res.failed[0].message}` : '压缩失败')
  } catch (e) {
    const err = e as { code?: string; message?: string }
    if (err.code === CODE_CANCELLED) showToast('已取消')
    else showFailToast(err.message ? `压缩失败：${err.message}` : '压缩失败')
  } finally {
    nativeBusy.value = false
  }
}

/**
 * 保存一份原生成品到相册。
 *
 * @param path 缓存路径
 * @param name 保存名
 * @param mime MIME
 */
async function saveNative(path: string, name: string, mime: string): Promise<void> {
  if (nativeSaving.value) return
  nativeSaving.value = true
  try {
    const res = await call<{ items: unknown[] }>('native.file.save', { items: [{ path, name, mime }] }, { timeoutMs: 0 })
    showSuccessToast(`已保存 ${res.items.length} 张到相册`)
  } catch (e) {
    const msg = (e as { message?: string }).message
    showFailToast(msg ? `保存失败：${msg}` : '保存失败')
  } finally {
    nativeSaving.value = false
  }
}

/**
 * 用某份成品覆盖第一张原图：先二次确认（文件名取点击当下的第一张），再调原生。
 *
 * @param path 成品缓存路径
 */
async function overwriteFirst(path: string): Promise<void> {
  const first = firstImage.value
  if (overwriting.value || !first?.sourceHandle || overwriteState.value.disabled) return
  try {
    await showConfirmDialog({ title: '保存并覆盖原图', message: confirmText(first.name), confirmButtonText: '覆盖' })
  } catch {
    return
  }
  overwriting.value = true
  try {
    await overwriteOriginal(path, first.sourceHandle)
    showSuccessToast('已覆盖原图')
  } catch (e) {
    showFailToast(overwriteErrorText(e))
  } finally {
    overwriting.value = false
  }
}

/** 开始拼接：有宿主走原生；否则逐张解码绘制，用完即关位图，降低内存峰值 */
async function run(): Promise<void> {
  if (native) return runNative()
  const mime = FORMAT_MIME[format.value]
  const lay = layout.value
  await process([images.value.slice()], async (list) => {
    const canvas = createCanvas(lay.width, lay.height)
    try {
      const ctx = canvas.getContext('2d')!
      // 先铺背景（JPEG 无透明，PNG 也铺，保证间距处颜色一致）
      ctx.fillStyle = bg.value
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < list.length; i++) {
        const bmp = await loadBitmap(list[i])
        const r = lay.items[i]
        const piece = drawScaled(bmp, r.w, r.h)
        bmp.close()
        ctx.drawImage(piece, r.x, r.y)
        releaseCanvas(piece)
      }
      const blob = await canvasToBlob(canvas, mime, format.value === 'jpeg' ? JPEG_QUALITY : undefined)
      const ext = format.value === 'jpeg' ? 'jpg' : 'png'
      return { name: `${NAME_PREFIX}_${Date.now()}.${ext}`, blob, width: lay.width, height: lay.height }
    } finally {
      releaseCanvas(canvas)
    }
  })
}

onBeforeUnmount(() => {
  images.value.forEach((i) => i.release())
  clearNative()
})
</script>

<template>
  <div class="tool-page">
    <tool-group :title="`选择图片（2~${MAX_PICK} 张，可调整顺序）`">
      <image-thumb-list :images="images" sortable @remove="remove" @move="move" />
      <p v-if="!images.length" class="tool-hint">点底部「相册」或「拍照」选图，可以多选。</p>
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <van-cell title="方向" center>
          <template #value>
            <van-radio-group v-model="direction" direction="horizontal" class="is-radios">
              <van-radio name="v">纵向</van-radio>
              <van-radio name="h">横向</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell :title="unifyLabel" center>
          <template #right-icon><van-switch v-model="unify" size="22" /></template>
        </van-cell>
        <van-cell v-if="!unify" title="对齐" center>
          <template #value>
            <van-radio-group v-model="align" direction="horizontal" class="is-radios">
              <van-radio name="start">{{ direction === 'v' ? '靠左' : '靠上' }}</van-radio>
              <van-radio name="center">居中</van-radio>
              <van-radio name="end">{{ direction === 'v' ? '靠右' : '靠下' }}</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell title="间距" :value="`${gap} px`" />
      </van-cell-group>
      <div class="is-slider"><van-slider v-model="gap" :min="0" :max="GAP_MAX" /></div>
      <van-cell-group :border="false">
        <van-cell title="背景色" center>
          <template #value><color-picker v-model="bg" label="背景色" /></template>
        </van-cell>
        <van-cell title="输出格式" center>
          <template #value>
            <van-radio-group v-model="format" direction="horizontal" class="is-radios">
              <van-radio name="png">PNG</van-radio>
              <van-radio name="jpeg">JPEG</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
      </van-cell-group>
      <p v-if="slowHint" class="tool-hint is-warn">{{ slowHint }}</p>
      <p v-if="layout.width" class="tool-hint" :class="{ 'is-warn': tooBig }">
        预计输出 {{ layout.width }}×{{ layout.height }}
        <template v-if="tooBig">，超出上限，请减少图片、开启{{ unifyLabel }}或调小间距</template>
      </p>
    </tool-group>

    <p v-if="busy || nativeBusy" class="tool-hint">{{ busy ? `处理中 ${progress}` : `${nativeLabel} ${nativeProgress}` }}</p>

    <tool-group v-if="stitched" title="结果（点击预览）">
      <native-result-list :rows="stitchRows" />
      <div class="is-actions">
        <van-button type="primary" plain round :loading="nativeSaving" @click="saveNative(stitched.path, stitched.name, stitched.mime)">
          保存
        </van-button>
        <van-button
          v-if="overwriteState.visible"
          plain
          round
          :loading="overwriting"
          :disabled="overwriteState.disabled"
          @click="overwriteFirst(stitched.path)"
        >
          保存并覆盖原图
        </van-button>
      </div>
      <p v-if="overwriteState.hint" class="tool-hint">{{ overwriteState.hint }}</p>
      <template v-if="compressUsesQuality">
        <van-cell title="压缩质量" :value="`${compressQuality}%`" />
        <div class="is-slider"><van-slider v-model="compressQuality" :min="QUALITY_MIN" :max="QUALITY_MAX" /></div>
      </template>
      <p v-else class="tool-hint">PNG 为无损压缩，体积变化有限；想压得更小可把输出格式改成 JPEG。</p>
      <p v-if="pngShrinkHint" class="tool-hint is-warn">{{ pngShrinkHint }}</p>
      <van-button block plain round :loading="nativeBusy" @click="runCompress">压缩</van-button>
    </tool-group>

    <tool-group v-if="compressed" title="压缩结果（点击预览）">
      <native-result-list :rows="compressRows" />
      <div class="is-actions">
        <van-button type="primary" plain round :loading="nativeSaving" @click="saveNative(compressed.path, compressed.name, compressed.mime)">
          保存
        </van-button>
        <van-button
          v-if="overwriteState.visible"
          plain
          round
          :loading="overwriting"
          :disabled="overwriteState.disabled"
          @click="overwriteFirst(compressed.path)"
        >
          保存并覆盖原图
        </van-button>
      </div>
      <p v-if="overwriteState.hint" class="tool-hint">{{ overwriteState.hint }}</p>
    </tool-group>

    <tool-group v-if="results.length" title="结果（点击预览）">
      <image-result-list :results="results" />
      <van-button type="primary" plain block round :loading="saving" @click="saveAll">保存</van-button>
    </tool-group>

    <!-- 底部动作栏：相册 / 拍照追加图片，主按钮开始拼接（原生任务进行中变成取消）；各路径的保存按钮留在结果区 -->
    <bottom-actions
      album
      photo
      main
      :main-text="nativeBusy ? '取消' : busy ? '拼接中' : '开始拼接'"
      :main-type="nativeBusy ? 'danger' : 'primary'"
      :disabled="{ album: busy || nativeBusy, photo: busy || nativeBusy, main: busy || (!nativeBusy && (images.length < 2 || tooBig)) }"
      @album="add"
      @photo="shoot"
      @main="nativeBusy ? cancelNative() : run()"
    />
  </div>
</template>

<style lang="scss" scoped>
.is-radios {
  justify-content: flex-end;
}

/* 滑杆留出触控空间 */
.is-slider {
  padding: $space-2 $space-3 $space-3;
}

/* 保存类按钮并排 */
.is-actions {
  display: flex;
  gap: $space-2;

  > .van-button {
    flex: 1;
  }
}

/* 超限警告 */
.is-warn {
  color: var(--c-error);
}
</style>
