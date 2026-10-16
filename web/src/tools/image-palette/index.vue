<script setup lang="ts">
// 取色器：上面是图片预览区，底部动作栏（左相册、右拍照）；提取图片主色（median-cut），长按图片取色并显示放大镜；点色块全屏显示，点一行复制 HEX，点右侧箭头带着颜色去颜色助手
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import ColorFullscreen from '@/shared/ColorFullscreen.vue'
import { cameraItemToPicked, captureCamera, clearCamera, isAlbum, isCancelled } from '@/native/camera'
import { copyText } from '@/shared/clipboard'
import { loupeAbove } from '@/shared/color-picker'
import { fitMaxEdge } from '@/shared/image-calc'
import { drawScaled, loadBitmap, EDIT_BASIC, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'
import {
  getPixel,
  LONG_PRESS_MS,
  LOUPE_GAP,
  LOUPE_SIZE,
  loadZoom,
  loupeSourceRect,
  movedBeyondSlop,
  loupeWindow,
  medianCut,
  PALETTE_DEFAULT,
  PALETTE_MAX,
  PALETTE_MIN,
  pointToPixel,
  readableTextColor,
  SAMPLE_MAX_EDGE,
  toHex,
  toRgbText,
  type PaletteColor,
  type Rgb,
  ZOOM_DEFAULT,
  ZOOM_KEY,
  ZOOM_MAX,
  ZOOM_MIN,
} from './logic'

/** 当前图片 */
const image = ref<PickedImage | null>(null)
/** 主色数量 */
const count = ref(PALETTE_DEFAULT)
/** 主色结果 */
const palette = ref<PaletteColor[]>([])
/** 点选的颜色 */
const picked = ref<Rgb | null>(null)
/** 解析中 */
const loading = ref(false)

/** 取样数据：缩小后的 RGBA，用于取点与算主色（≤256px，占用很小） */
let sample: { data: Uint8ClampedArray; width: number; height: number } | null = null

/** 采用一张新图：释放旧图、解码取样、提取主色；来自相册时顺手清掉旧的拍照产物（拍照产物由原生拍前清理） */
async function accept(got: PickedImage, fromCamera: boolean): Promise<void> {
  try {
    loading.value = true
    image.value?.release()
    image.value = got
    picked.value = null
    palette.value = []
    sample = null
    if (!fromCamera) void clearCamera()
    const bmp = await loadBitmap(got)
    try {
      const size = fitMaxEdge(bmp.width, bmp.height, SAMPLE_MAX_EDGE)
      const canvas = drawScaled(bmp, size.width, size.height)
      sample = { data: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height }
      releaseCanvas(canvas)
    } finally {
      bmp.close()
    }
    extract()
  } catch (e) {
    showFailToast((e as { message?: string }).message ?? '读取图片失败')
  } finally {
    loading.value = false
  }
}

/** 从自带相册页单选一张 */
async function fromAlbum(): Promise<void> {
  if (loading.value) return
  try {
    const [got] = await pickImages({ edit: EDIT_BASIC, multiple: false, max: 1, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got) await accept(got, false)
  } catch (e) {
    showFailToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 打开原生相机拍一张；取消或拍到的不是照片就什么都不做 */
async function takePhoto(): Promise<void> {
  if (loading.value) return
  try {
    const r = await captureCamera({ modes: ['photo'] })
    if (isCancelled(r) || isAlbum(r) || r.kind !== 'image') return
    await accept(cameraItemToPicked(r), true)
  } catch (e) {
    showFailToast((e as { message?: string }).message ?? '拍照失败')
  }
}

/** 按当前数量重算主色 */
function extract(): void {
  palette.value = sample ? medianCut(sample.data, count.value) : []
}

/** 读存下来的放大倍数，存储不可用时用默认值 */
function readZoom(): number {
  try {
    return loadZoom(window.localStorage.getItem(ZOOM_KEY))
  } catch {
    return ZOOM_DEFAULT
  }
}

/** 放大镜倍数，可调，改动后记住 */
const zoom = ref(readZoom())
/** 当前倍数对应的取样窗口边长（原图像素） */
const win = computed(() => loupeWindow(zoom.value))
watch(zoom, (v) => {
  try {
    window.localStorage.setItem(ZOOM_KEY, String(v))
  } catch {
    // 存储不可用时只在本次生效
  }
})

/** 图片容器、图片与放大镜画布的 DOM */
const viewRef = ref<HTMLElement | null>(null)
const imgRef = ref<HTMLImageElement | null>(null)
const loupeRef = ref<HTMLCanvasElement | null>(null)
/** 放大镜：按住图片时跟着手指，显示手指下方原图像素的放大画面；null 表示没在按 */
const loupe = ref<{ x: number; y: number; above: boolean; hex: string } | null>(null)

/**
 * 在放大镜画布上画指向位置周围的原图像素，并读出正中间那个像素的颜色。
 * 读不出（画布被污染、指到图外）时返回 null，由调用方用取样图兜底。
 *
 * @param nx 指向像素的原图 x
 * @param ny 指向像素的原图 y
 */
function drawLoupe(nx: number, ny: number): Rgb | null {
  const img = imgRef.value
  const canvas = loupeRef.value
  const ctx = canvas?.getContext('2d', { willReadFrequently: true })
  if (!img || !canvas || !ctx) return null
  const { sx, sy, size } = loupeSourceRect(nx, ny, win.value)
  ctx.clearRect(0, 0, size, size)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, sx, sy, size, size, 0, 0, size, size)
  try {
    const mid = Math.floor(size / 2)
    const [r, g, b, a] = ctx.getImageData(mid, mid, 1, 1).data
    return a === 0 ? null : { r, g, b }
  } catch {
    return null
  }
}

/** 按手指位置取色并更新放大镜：优先取原图像素，取不到用缩小的取样图兜底 */
function pickAt(e: PointerEvent): void {
  const img = imgRef.value
  const view = viewRef.value
  if (!img || !view) return
  const rect = img.getBoundingClientRect()
  const ox = e.clientX - rect.left
  const oy = e.clientY - rect.top
  const nat = pointToPixel(ox, oy, rect.width, rect.height, img.naturalWidth, img.naturalHeight)
  let c: Rgb | null = nat ? drawLoupe(nat.x, nat.y) : null
  if (!c && sample) {
    const p = pointToPixel(ox, oy, rect.width, rect.height, sample.width, sample.height)
    c = p ? getPixel(sample.data, sample.width, sample.height, p.x, p.y) : null
  }
  if (!c) return
  picked.value = c
  const vr = view.getBoundingClientRect()
  const x = Math.min(rect.right, Math.max(rect.left, e.clientX)) - vr.left
  const y = Math.min(rect.bottom, Math.max(rect.top, e.clientY)) - vr.top
  loupe.value = { x, y, above: loupeAbove(y - (rect.top - vr.top), LOUPE_SIZE, LOUPE_GAP), hex: toHex(c) }
}

/**
 * 按下图片：普通触摸不干预，页面照常滚动；按住不动超过 {@link LONG_PRESS_MS} 才唤起放大镜并开始取色，
 * 之后手指拖动持续取色（此时拦掉 touchmove 防止页面跟着滚），松手收起放大镜（颜色保留）。
 * 长按前手指漂移超过范围，视为在滑动页面，取消长按。鼠标按下立即取色。
 */
function onDown(e: PointerEvent): void {
  if (!image.value) return
  const el = e.currentTarget as HTMLElement
  const startX = e.clientX
  const startY = e.clientY
  let active = false
  let timer: ReturnType<typeof setTimeout> | null = null

  /** 进入取色：捕获指针、立即取色 */
  const activate = (at: PointerEvent): void => {
    active = true
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // 指针号无效时不捕获
    }
    pickAt(at)
  }
  const move = (ev: PointerEvent): void => {
    if (active) {
      pickAt(ev)
    } else if (timer !== null && movedBeyondSlop(ev.clientX - startX, ev.clientY - startY)) {
      clearTimeout(timer)
      timer = null
    }
  }
  /** 取色期间拦掉 touchmove，页面才不会跟着滚 */
  const block = (ev: TouchEvent): void => {
    if (active && ev.cancelable) ev.preventDefault()
  }
  const stop = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    active = false
    loupe.value = null
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', stop)
    el.removeEventListener('pointercancel', stop)
    el.removeEventListener('touchmove', block)
  }

  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', stop)
  el.addEventListener('pointercancel', stop)
  el.addEventListener('touchmove', block, { passive: false })
  if (e.pointerType === 'mouse') activate(e)
  else timer = setTimeout(() => activate(e), LONG_PRESS_MS)
}

/** 路由器：跳颜色助手用 */
const router = useRouter()
/** 全屏展示的颜色 HEX */
const fullHex = ref('#000000')
/** 全屏弹层是否显示 */
const fullShow = ref(false)

/**
 * 全屏显示某个颜色。
 *
 * @param c 要显示的颜色
 */
function showFull(c: Rgb): void {
  fullHex.value = toHex(c)
  fullShow.value = true
}

/**
 * 跳到颜色助手，并把这个颜色带过去（`?c=` 后面是不带 # 的 HEX）。
 *
 * @param c 要带过去的颜色
 */
function goConvert(c: Rgb): void {
  void router.push({ path: '/tool/color-convert', query: { c: toHex(c).slice(1) } })
}

/** 复制文本并反馈 */
async function copy(text: string): Promise<void> {
  if (await copyText(text)) showSuccessToast(`已复制 ${text}`)
  else showFailToast('复制失败')
}

onBeforeUnmount(() => {
  image.value?.release()
  void clearCamera()
})
</script>

<template>
  <div class="tool-page">
    <tool-group :title="`${image ? '长按图片取色' : '预览'}`">
      <!-- 空状态：和垃圾识别一样的灰色线框图标 -->
      <div v-if="!image" class="pal-empty"><van-icon name="photo-o" class="pal-empty__icon" /><span class="tool-hint">用下方的相册或拍照选一张图</span></div>
      <div v-if="image" ref="viewRef" class="pal-view">
        <img ref="imgRef" class="pal-img" :src="image.url" alt="待取色图片" draggable="false" @pointerdown="onDown" @contextmenu.prevent />
        <!-- 放大镜：画布只有 win 像素见方（倍数越大窗口越小），用 CSS 放大并保留像素颗粒；一直挂着（v-show），免得首次取色时画布还没出来 -->
        <div
          v-show="loupe"
          class="pal-loupe"
          :class="{ 'is-below': loupe && !loupe.above }"
          :style="{ left: `${loupe?.x ?? 0}px`, top: `${loupe?.y ?? 0}px`, width: `${LOUPE_SIZE}px`, height: `${LOUPE_SIZE}px` }"
        >
          <canvas ref="loupeRef" class="pal-loupe__canvas" :width="win" :height="win" />
          <i class="pal-loupe__center" :style="{ width: `${LOUPE_SIZE / win}px`, height: `${LOUPE_SIZE / win}px` }" />
          <span class="pal-loupe__hex">{{ loupe?.hex }}</span>
        </div>
      </div>
      <template v-if="image">
        <h3 class="tool-group__title pal-zoom-title">放大倍数 {{ zoom }}×</h3>
        <div class="is-slider"><van-slider v-model="zoom" :min="ZOOM_MIN" :max="ZOOM_MAX" :step="1" /></div>
      </template>
      <van-loading v-if="loading" size="20" class="pal-loading" />
    </tool-group>

    <!-- 使用说明：放在预览区卡片下面（卡片外），信息样式（蓝） -->
    <van-notice-bar
      class="pal-notice"
      color="#1989fa"
      background="#ecf9ff"
      wrapable
      :scrollable="false"
      text="长按图片取色（放大镜帮你对准像素）；点左侧色块全屏显示，点一行复制 HEX，点右侧箭头带着颜色到颜色助手；占比按取样缩略图的像素统计。"
    />

    <tool-group v-if="picked" title="点选的颜色">
      <van-cell-group :border="false">
        <!-- 点色块全屏；点一行复制 HEX；右侧「复制 RGB」单独复制 RGB，箭头带着颜色去颜色助手 -->
        <van-cell center clickable :title="toHex(picked)" :label="toRgbText(picked)" @click="copy(toHex(picked))">
          <template #icon>
            <button type="button" class="pal-chip" :style="{ background: toHex(picked) }" aria-label="全屏显示" @click.stop="showFull(picked)" />
          </template>
          <template #value><van-button size="mini" plain @click.stop="copy(toRgbText(picked))">复制 RGB</van-button></template>
          <template #right-icon>
            <van-icon name="arrow" class="pal-go" aria-label="到颜色助手" @click.stop="goConvert(picked)" />
          </template>
        </van-cell>
      </van-cell-group>
    </tool-group>

    <tool-group v-if="image" :title="`主色（${count} 种）`">
      <div class="is-slider"><van-slider v-model="count" :min="PALETTE_MIN" :max="PALETTE_MAX" @change="extract" /></div>
      <van-cell-group :border="false">
        <van-cell v-for="(c, i) in palette" :key="i" center clickable :title="toHex(c)" :label="toRgbText(c)" @click="copy(toHex(c))">
          <!-- 左侧色块里居中显示占比，字色按底色深浅取黑白保证看得清；点它全屏 -->
          <template #icon>
            <button
              type="button"
              class="pal-chip"
              :style="{ background: toHex(c), color: readableTextColor(c) }"
              aria-label="全屏显示"
              @click.stop="showFull(c)"
            >{{ Math.round(c.ratio * 100) }}%</button>
          </template>
          <template #right-icon>
            <van-icon name="arrow" class="pal-go" aria-label="到颜色助手" @click.stop="goConvert(c)" />
          </template>
        </van-cell>
      </van-cell-group>
    </tool-group>

    <color-fullscreen v-model="fullShow" :color="fullHex" />

    <!-- 底部动作栏：左边相册、右边拍照（没有模型，不带 AI） -->
    <bottom-actions album main main-text="拍照" main-type="danger" :disabled="{ album: loading, main: loading }" @album="fromAlbum" @main="takePhoto" />
  </div>
</template>

<style lang="scss" scoped>
/* 图片区：点按取色 */
.pal-view {
  position: relative;
  margin-bottom: $space-3;
  border-radius: 8px;
  background: var(--c-surface-active);
  cursor: crosshair;
}

/* 不用 object-fit，保证元素矩形就是图片矩形，点击坐标才准 */
.pal-img {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  margin: 0 auto;
  border-radius: 8px;
  user-select: none;
  -webkit-touch-callout: none;
  touch-action: pan-y; /* 普通滑动照常滚动页面；长按后的取色由脚本拦掉 touchmove */
}

/* 空状态：灰色线框图标加一行提示，高度和预览区接近 */
.pal-empty {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1 / 1;
  width: 100%;
  margin-bottom: $space-3;
  border-radius: 8px;
  background: var(--c-surface-active);

  &__icon {
    font-size: 64px;
    color: var(--c-text-muted);
  }
}

/* 使用说明条：在预览区卡片下面、卡片外，圆角与卡片一致 */
.pal-notice {
  border-radius: var(--tool-card-radius);
}

/* 解析中的转圈 */
.pal-loading {
  display: flex;
  justify-content: center;
}

/* 放大倍数滑块标题 */
.pal-zoom-title {
  margin-top: 0;
}

/* 放大镜：圆形、白边、投影；默认在手指上方，上方放不下翻到下方 */
.pal-loupe {
  position: absolute;
  z-index: 2;
  margin: -134px 0 0 -55px; /* 圆心在手指上方：-(直径 + 间距)，水平居中 */
  overflow: hidden;
  border: 3px solid #fff;
  border-radius: 50%;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
  pointer-events: none;

  &.is-below {
    margin-top: 24px; /* 翻到手指下方 */
  }

  &__canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }

  /* 正中间那个像素的方框 */
  &__center {
    position: absolute;
    top: 50%;
    left: 50%;
    box-sizing: border-box;
    border: 2px solid #fff;
    outline: 1px solid rgba(0, 0, 0, 0.6);
    transform: translate(-50%, -50%);
  }

  /* 底部色值小标签 */
  &__hex {
    position: absolute;
    bottom: 8px;
    left: 50%;
    padding: 1px 6px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-family: monospace;
    font-size: 11px;
    transform: translateX(-50%);
  }
}

/* 单元格左侧的颜色块：48px 圆角方块，占比居中显示，可点（全屏） */
.pal-chip {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin-right: $space-3;
  padding: 0;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  -webkit-tap-highlight-color: transparent;
}

/* 右侧箭头：点击区放大到 44px，免得误点整行 */
.pal-go {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -12px -8px -12px 0;
  font-size: 18px;
  color: var(--c-text-muted);
}

.is-slider {
  padding: $space-2 $space-3 $space-3;
}

</style>
