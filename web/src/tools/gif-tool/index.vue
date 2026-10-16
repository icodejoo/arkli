<script setup lang="ts">
// GIF 合成/分解：多图合成动图（自写编码器）；动图拆成逐帧 PNG（优先 ImageDecoder，没有则用内置解码）
import BottomActions from '@/shared/BottomActions.vue'
import ColorPicker from '@/shared/ColorPicker.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { showFailToast, showToast } from 'vant'
import ImageThumbList from '@/shared/ImageThumbList.vue'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { shootPhoto } from '@/shared/shootPhoto'
import { baseName, formatBytes } from '@/shared/image-calc'
import { canvasToBlob, createCanvas, loadBitmap, pickImages, releaseCanvas, saveBlob, type PickedImage } from '@/shared/image-io'
import { GifWriter } from './gif-encoder'
import { parseGif, renderGif, type DecodedFrame, type ParsedGif } from './gif-decoder'
import {
  canvasSize,
  checkFrameCount,
  clampMaxEdge,
  csToMs,
  DEFAULT_DELAY_MS,
  DEFAULT_MAX_EDGE,
  formatSeconds,
  frameFileName,
  isGif,
  MAX_COMPOSE_FRAMES,
  MAX_DECOMPOSE_FRAMES,
  MIN_MAX_EDGE,
  placeFrame,
  playIndices,
  resolveDelays,
  totalDurationMs,
  type FitMode,
  type PlayOrder,
} from './logic'

/** 统一延迟的可调范围（毫秒） */
const DELAY_MIN_MS = 20
const DELAY_MAX_MS = 5000
/** 延迟步进（毫秒） */
const DELAY_STEP_MS = 10
/** 默认背景色（适应模式留边处） */
const BG_DEFAULT = '#ffffff'
/** 合成输出文件名前缀 */
const COMPOSE_PREFIX = 'anim'
/** 解码不可用时的提示 */
const NO_DECODER_TEXT = '当前 WebView 解不了这个 GIF，请在较新的系统 WebView 上使用'

/** ImageDecoder 返回的帧（VideoFrame）的最小形状 */
interface VideoFrameLike {
  /** 释放帧 */
  close: () => void
}
/** ImageDecoder 的最小形状（TS 自带 DOM 库未必有） */
interface ImageDecoderLike {
  /** 解出指定帧 */
  decode: (o: { frameIndex: number }) => Promise<{ image: VideoFrameLike }>
  /** 释放解码器 */
  close: () => void
}
/** ImageDecoder 构造函数 */
type ImageDecoderCtor = new (init: { data: Uint8Array; type: string }) => ImageDecoderLike

/** 当前页签：合成 / 分解 */
const tab = ref<'compose' | 'split'>('compose')

// ---------- 合成 ----------

/** 已选图片（顺序即基础帧顺序） */
const images = ref<PickedImage[]>([])
/** 每张图的单独延迟（毫秒），与 images 同下标 */
const delays = ref<number[]>([])
/** 统一延迟（毫秒） */
const uniformMs = ref(DEFAULT_DELAY_MS)
/** 是否逐帧设置延迟 */
const perFrame = ref(false)
/** 播放顺序 */
const order = ref<PlayOrder>('normal')
/** 统一尺寸方式 */
const fit = ref<FitMode>('contain')
/** 画面长边上限（像素） */
const maxEdge = ref(DEFAULT_MAX_EDGE)
/** 背景色 */
const bg = ref(BG_DEFAULT)
/** 循环：true 无限循环，false 只播一次 */
const loopForever = ref(true)
/** 是否抖动 */
const dither = ref(false)
/** 合成结果与批处理状态 */
const compose = useImageResults()
/** 合成进度文案 */
const composeText = ref('')

/** 实际播放的帧下标序列 */
const playList = computed(() => playIndices(images.value.length, order.value))
/** 帧数校验 */
const frameCheck = computed(() => checkFrameCount(playList.value.length, MAX_COMPOSE_FRAMES))
/** 画面尺寸预估 */
const size = computed(() => canvasSize(images.value.map((i) => ({ width: i.width, height: i.height })), maxEdge.value))
/** 播放总时长（毫秒） */
const duration = computed(() =>
  totalDurationMs(
    resolveDelays(
      playList.value.length,
      uniformMs.value,
      playList.value.map((i) => (perFrame.value ? delays.value[i] : undefined)),
    ),
  ),
)

/** 相册添加图片 */
async function add(): Promise<void> {
  const room = MAX_COMPOSE_FRAMES - images.value.length
  if (room <= 0) {
    showToast(`最多 ${MAX_COMPOSE_FRAMES} 张`)
    return
  }
  try {
    const got = await pickImages({ multiple: true, max: room, onFailed: (f) => showToast(`${f.length} 张读取失败：${f[0].message}`) })
    images.value = images.value.concat(got)
    delays.value = delays.value.concat(got.map(() => uniformMs.value))
    compose.clear()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照添加一张 */
async function shoot(): Promise<void> {
  if (images.value.length >= MAX_COMPOSE_FRAMES) {
    showToast(`最多 ${MAX_COMPOSE_FRAMES} 张`)
    return
  }
  const got = await shootPhoto()
  if (!got) return
  images.value = images.value.concat(got)
  delays.value = delays.value.concat(uniformMs.value)
  compose.clear()
}

/** 移除第 i 张 */
function remove(i: number): void {
  images.value[i].release()
  images.value.splice(i, 1)
  delays.value.splice(i, 1)
  compose.clear()
}

/** 把第 i 张移动 delta 位（图与延迟同步移动） */
function move(i: number, delta: number): void {
  const j = i + delta
  if (j < 0 || j >= images.value.length) return
  const [it] = images.value.splice(i, 1)
  const [d] = delays.value.splice(i, 1)
  images.value.splice(j, 0, it)
  delays.value.splice(j, 0, d)
  compose.clear()
}

/** 调整长边上限（滑杆回调，保证在合法范围） */
function onEdge(v: number): void {
  maxEdge.value = clampMaxEdge(v)
}

/** 让出一轮事件循环，避免长任务卡住界面 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 把一张图按统一尺寸画好，返回 RGBA 像素；位图与画布用完即释放 */
async function renderFrame(img: PickedImage, w: number, h: number): Promise<Uint8ClampedArray> {
  const bmp = await loadBitmap(img)
  const canvas = createCanvas(w, h)
  try {
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = bg.value
    ctx.fillRect(0, 0, w, h)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const p = placeFrame({ width: bmp.width, height: bmp.height }, { width: w, height: h }, fit.value)
    ctx.drawImage(bmp, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh)
    return ctx.getImageData(0, 0, w, h).data
  } finally {
    bmp.close()
    releaseCanvas(canvas)
  }
}

/** 开始合成：逐帧画、逐帧压缩；来回播放时重复的帧缓存一份像素复用 */
async function runCompose(): Promise<void> {
  const seq = playList.value
  const { width, height } = size.value
  const delayCs = resolveDelays(
    seq.length,
    uniformMs.value,
    seq.map((i) => (perFrame.value ? delays.value[i] : undefined)),
  )
  const uses = new Map<number, number>()
  seq.forEach((i) => uses.set(i, (uses.get(i) ?? 0) + 1))
  await compose.process([0], async () => {
    const writer = new GifWriter({ width, height, loop: loopForever.value ? 0 : 1, dither: dither.value })
    const cache = new Map<number, Uint8ClampedArray>()
    for (let k = 0; k < seq.length; k++) {
      composeText.value = `${k + 1}/${seq.length}`
      const idx = seq[k]
      let data = cache.get(idx)
      if (!data) {
        data = await renderFrame(images.value[idx], width, height)
        if ((uses.get(idx) ?? 0) > 1) cache.set(idx, data)
      }
      writer.addFrame(data, delayCs[k])
      await tick()
    }
    composeText.value = ''
    const blob = new Blob([writer.finish() as BlobPart], { type: 'image/gif' })
    return {
      name: `${COMPOSE_PREFIX}_${Date.now()}.gif`,
      blob,
      width,
      height,
      note: `${seq.length} 帧，${formatSeconds(duration.value)}`,
    }
  })
  composeText.value = ''
}

// ---------- 分解 ----------

/** 选中的 GIF */
const gif = ref<PickedImage | null>(null)
/** 解析出的 GIF 信息（帧数、时长等） */
const info = ref<{ width: number; height: number; frames: number; durationMs: number; truncated: boolean } | null>(null)
/** 分解结果与批处理状态 */
const split = useImageResults()
/** 使用的解码方式提示 */
const decoderNote = ref('')

/** 选择一个 GIF */
async function pickGif(): Promise<void> {
  try {
    const got = await pickImages({ multiple: false, max: 1 })
    if (!got.length) return
    if (!isGif(got[0].mime, got[0].name)) {
      got[0].release()
      showToast('请选择 GIF 动图')
      return
    }
    gif.value?.release()
    gif.value = got[0]
    info.value = null
    decoderNote.value = ''
    split.clear()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 取得 ImageDecoder 构造函数，不支持返回 null */
function getImageDecoder(): ImageDecoderCtor | null {
  const ctor = (globalThis as unknown as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder
  return typeof ctor === 'function' ? ctor : null
}

/** 把 ImageDecoder 的一帧或内置解码的一帧画成 PNG */
async function frameToPng(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Promise<Blob> {
  const canvas = createCanvas(w, h)
  try {
    draw(canvas.getContext('2d')!)
    return await canvasToBlob(canvas, 'image/png')
  } finally {
    releaseCanvas(canvas)
  }
}

/** 开始分解：先解析块结构拿帧数和时长，再逐帧转 PNG（一帧一帧来，不留全部位图） */
async function runSplit(): Promise<void> {
  const src = gif.value
  if (!src) return
  let bytes: Uint8Array
  let parsed: ParsedGif
  try {
    bytes = new Uint8Array(await (await fetch(src.url)).arrayBuffer())
    parsed = parseGif(bytes)
  } catch {
    showFailToast(NO_DECODER_TEXT)
    return
  }
  const total = Math.min(parsed.frames.length, MAX_DECOMPOSE_FRAMES)
  const truncated = parsed.frames.length > total
  const durationMs = totalDurationMs(parsed.frames.slice(0, total).map((f) => f.delayCs))
  info.value = { width: parsed.width, height: parsed.height, frames: parsed.frames.length, durationMs, truncated }
  if (truncated) showToast(`帧数太多，只拆前 ${MAX_DECOMPOSE_FRAMES} 帧`)

  const Ctor = getImageDecoder()
  let decoder: ImageDecoderLike | null = null
  let fallback: Generator<DecodedFrame> | null = null
  if (Ctor) {
    try {
      decoder = new Ctor({ data: bytes, type: 'image/gif' })
      decoderNote.value = ''
    } catch {
      decoder = null
    }
  }
  if (!decoder) {
    fallback = renderGif(parsed)
    decoderNote.value = '当前 WebView 没有 ImageDecoder，已改用内置解码，速度较慢；建议在较新的系统 WebView 上使用'
  }
  const base = baseName(src.name)
  try {
    await split.process(
      Array.from({ length: total }, (_, i) => i),
      async (i) => {
        const blob = decoder
          ? await decodeWithDecoder(decoder, i, parsed)
          : await decodeWithFallback(fallback!, parsed)
        return { name: frameFileName(base, i, total), blob, width: parsed.width, height: parsed.height, note: `延迟 ${csToMs(parsed.frames[i].delayCs)} ms` }
      },
    )
  } finally {
    decoder?.close()
  }
}

/** 用 ImageDecoder 解第 i 帧并转 PNG */
async function decodeWithDecoder(dec: ImageDecoderLike, i: number, p: ParsedGif): Promise<Blob> {
  const { image } = await dec.decode({ frameIndex: i })
  try {
    return await frameToPng(p.width, p.height, (ctx) => ctx.drawImage(image as unknown as CanvasImageSource, 0, 0))
  } finally {
    image.close()
  }
}

/** 用内置解码取下一帧并转 PNG */
async function decodeWithFallback(gen: Generator<DecodedFrame>, p: ParsedGif): Promise<Blob> {
  const next = gen.next()
  if (next.done) throw new Error(NO_DECODER_TEXT)
  const rgba = next.value.rgba
  const blob = await frameToPng(p.width, p.height, (ctx) => ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, p.width, p.height), 0, 0))
  await tick()
  return blob
}

/** 保存单帧 */
async function saveOne(i: number): Promise<void> {
  const r = split.results.value[i]
  try {
    const res = await saveBlob(r.blob, r.name)
    showToast(res.mode === 'native' ? '已保存到相册' : '已下载')
  } catch (e) {
    showFailToast((e as { message?: string }).message ?? '保存失败')
  }
}

onBeforeUnmount(() => {
  images.value.forEach((i) => i.release())
  gif.value?.release()
})
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="tab" shrink>
      <van-tab title="图片合成 GIF" name="compose" />
      <van-tab title="GIF 分解" name="split" />
    </van-tabs>

    <template v-if="tab === 'compose'">
      <tool-group :title="`选择图片（最多 ${MAX_COMPOSE_FRAMES} 张，可调整顺序）`">
        <image-thumb-list :images="images" sortable @remove="remove" @move="move" />
        <p v-if="!images.length" class="tool-hint">点底部「相册」或「拍照」选图，可以多选。</p>
      </tool-group>

      <tool-group>
        <van-cell-group :border="false">
          <van-cell title="尺寸方式" center>
            <template #value>
              <van-radio-group v-model="fit" direction="horizontal" class="is-radios">
                <van-radio name="contain">适应</van-radio>
                <van-radio name="cover">填充</van-radio>
                <van-radio name="stretch">拉伸</van-radio>
              </van-radio-group>
            </template>
          </van-cell>
          <van-cell title="长边上限" :value="`${maxEdge} px`" />
        </van-cell-group>
        <div class="is-slider"><van-slider :model-value="maxEdge" :min="MIN_MAX_EDGE" :max="DEFAULT_MAX_EDGE" @update:model-value="onEdge" /></div>
        <van-cell-group :border="false">
          <van-cell v-if="fit === 'contain'" title="留边颜色" center>
            <template #value><color-picker v-model="bg" label="留边颜色" /></template>
          </van-cell>
          <van-cell title="每帧延迟" center>
            <template #value><van-stepper v-model="uniformMs" :min="DELAY_MIN_MS" :max="DELAY_MAX_MS" :step="DELAY_STEP_MS" integer /></template>
          </van-cell>
          <van-cell title="逐帧设置延迟" center>
            <template #right-icon><van-switch v-model="perFrame" size="22" /></template>
          </van-cell>
        </van-cell-group>
        <van-cell-group v-if="perFrame && images.length" :border="false">
          <van-cell v-for="(img, i) in images" :key="img.url" :title="`第 ${i + 1} 帧`" center>
            <template #value><van-stepper v-model="delays[i]" :min="DELAY_MIN_MS" :max="DELAY_MAX_MS" :step="DELAY_STEP_MS" integer /></template>
          </van-cell>
        </van-cell-group>
        <van-cell-group :border="false">
          <van-cell title="播放顺序" center>
            <template #value>
              <van-radio-group v-model="order" direction="horizontal" class="is-radios">
                <van-radio name="normal">正放</van-radio>
                <van-radio name="reverse">倒放</van-radio>
                <van-radio name="pingpong">来回</van-radio>
              </van-radio-group>
            </template>
          </van-cell>
          <van-cell title="无限循环" center>
            <template #right-icon><van-switch v-model="loopForever" size="22" /></template>
          </van-cell>
          <van-cell title="抖动（渐变更细腻，体积更大）" center>
            <template #right-icon><van-switch v-model="dither" size="22" /></template>
          </van-cell>
        </van-cell-group>
        <p v-if="images.length" class="tool-hint" :class="{ 'is-warn': !frameCheck.ok }">
          共 {{ playList.length }} 帧，{{ size.width }}×{{ size.height }}，总时长 {{ formatSeconds(duration) }}
          <template v-if="!frameCheck.ok">；超出上限 {{ frameCheck.over }} 帧，请减少图片或改用正放</template>
        </p>
      </tool-group>

      <tool-group v-if="compose.results.value.length" title="结果（直接预览动图）">
        <image-result-list :results="compose.results.value" />
      </tool-group>
    </template>

    <template v-else>
      <tool-group title="选择 GIF">
        <image-thumb-list :images="gif ? [gif] : []" @remove="() => { gif?.release(); gif = null; info = null; split.clear() }" />
        <p v-if="!gif" class="tool-hint">点底部「相册」选一个 GIF 动图。</p>
        <p v-if="info" class="tool-hint">
          {{ info.width }}×{{ info.height }}，共 {{ info.frames }} 帧，总时长 {{ formatSeconds(info.durationMs) }}
          <template v-if="info.truncated">（只拆前 {{ MAX_DECOMPOSE_FRAMES }} 帧）</template>
        </p>
        <p v-if="decoderNote" class="tool-hint is-warn">{{ decoderNote }}</p>
      </tool-group>

      <tool-group v-if="split.results.value.length" :title="`逐帧结果（${split.results.value.length} 帧）`">
        <ul class="frames">
          <li v-for="(r, i) in split.results.value" :key="r.id" class="frame">
            <img class="frame__img" :src="r.url" :alt="r.name" loading="lazy" />
            <div class="frame__meta">{{ i + 1 }} · {{ formatBytes(r.blob.size) }}</div>
            <van-button size="mini" plain @click="saveOne(i)">保存</van-button>
          </li>
        </ul>
      </tool-group>
    </template>

    <!-- 底部动作栏：合成页有相册 / 拍照、保存与「合成 GIF」；分解页有相册（选 GIF）、全部保存与「开始分解」 -->
    <bottom-actions
      album
      :photo="tab === 'compose'"
      main
      :main-text="tab === 'compose' ? (compose.busy.value ? `合成中 ${composeText}` : '合成 GIF') : split.busy.value ? `拆帧中 ${split.progress.value}` : '开始分解'"
      :disabled="{
        album: tab === 'compose' ? compose.busy.value : split.busy.value,
        photo: compose.busy.value,
        main: tab === 'compose' ? compose.busy.value || images.length < 2 || !frameCheck.ok : split.busy.value || !gif,
      }"
      @album="tab === 'compose' ? add() : pickGif()"
      @photo="shoot"
      @main="tab === 'compose' ? runCompose() : runSplit()"
    >
      <van-action-bar-icon v-if="tab === 'compose'" text="保存" :disabled="!compose.results.value.length || compose.saving.value" @click="compose.saveAll"><template #icon><i-arkli-save /></template></van-action-bar-icon>
      <van-action-bar-icon v-else text="全部保存" :disabled="!split.results.value.length || split.saving.value" @click="split.saveAll"><template #icon><i-arkli-save /></template></van-action-bar-icon>
    </bottom-actions>
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


/* 警告文字 */
.is-warn {
  color: var(--c-error);
}

/* 逐帧缩略图网格 */
.frames {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: $space-2;
  margin: 0 0 $space-3;
  padding: 0;
  list-style: none;
}

.frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.frame__img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: contain;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: repeating-conic-gradient(#0001 0 25%, transparent 0 50%) 0 0 / 12px 12px;
}

.frame__meta {
  font-size: 12px;
  color: var(--c-text-muted);
}
</style>
