<script setup lang="ts">
// 带壳截图：把截图套进通用手机外壳 / 浏览器窗口 / 纯卡片，Canvas 自绘，不带任何品牌机框
import BottomActions from '@/shared/BottomActions.vue'
import ColorPicker from '@/shared/ColorPicker.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { baseName } from '@/shared/image-calc'
import { shootPhoto } from '@/shared/shootPhoto'
import { canvasToBlob, createCanvas, drawScaled, loadBitmap, EDIT_FULL, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'
import { BG_PRESETS, DEFAULT_ANGLE, frameLayout, gradientLine, type CutoutKind, type FrameLayout, type FrameStyle } from './logic'

/** 手机机身 / 刘海 / 挖孔颜色 */
const PHONE_BODY = '#111111'
/** 浏览器顶栏底色、地址栏底色、地址栏文字色 */
const BAR_BG = '#e8eaed'
const PILL_BG = '#ffffff'
const PILL_TEXT = '#5f6368'
/** 浏览器红黄绿三点颜色 */
const DOT_COLORS = ['#ff5f57', '#febc2e', '#28c840']
/** 阴影颜色 */
const SHADOW_COLOR = 'rgba(0, 0, 0, 0.35)'
/** 地址栏文字占胶囊高度比例 */
const PILL_FONT_RATIO = 0.55
/** 地址栏文字左右内边距占胶囊高度比例 */
const PILL_TEXT_PAD = 0.5
/** 默认地址栏文字 */
const DEFAULT_ADDRESS = 'https://example.com'
/** 输出文件名后缀 */
const NAME_SUFFIX = '-framed'

/** 当前截图 */
const image = ref<PickedImage | null>(null)
/** 外壳样式 */
const style = ref<FrameStyle>('phone')
/** 手机缺口 */
const cutout = ref<CutoutKind>('punch')
/** 边距百分比 */
const padPct = ref(8)
/** 圆角百分比 */
const radiusPct = ref(6)
/** 背景起始色 */
const c1 = ref(BG_PRESETS[0].c1)
/** 背景结束色 */
const c2 = ref(BG_PRESETS[0].c2)
/** 渐变角度 */
const angle = ref(DEFAULT_ANGLE)
/** 浏览器地址栏文字 */
const address = ref(DEFAULT_ADDRESS)
/** 结果与批处理状态 */
const { results, busy, saving, saveAll, process, clear } = useImageResults()

/** 当前设置下的布局预览（用于提示输出尺寸与是否被缩小） */
const layout = computed<FrameLayout | null>(() =>
  image.value && image.value.width
    ? frameLayout(image.value.width, image.value.height, { style: style.value, padPct: padPct.value, radiusPct: radiusPct.value, cutout: cutout.value })
    : null,
)

/** 采用新图：释放旧图并清掉旧结果 */
function adopt(img: PickedImage): void {
  image.value?.release()
  image.value = img
  clear()
}

/** 相册选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ edit: EDIT_FULL, multiple: false, max: 1, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got.length) adopt(got[0])
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照 */
async function shoot(): Promise<void> {
  const got = await shootPhoto()
  if (got) adopt(got)
}

/** 套用背景预设 */
function applyPreset(i: number): void {
  c1.value = BG_PRESETS[i].c1
  c2.value = BG_PRESETS[i].c2
}

/** 圆角矩形路径（不用 ctx.roundRect，旧内核没有） */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 画背景（纯色或线性渐变） */
function paintBackground(ctx: CanvasRenderingContext2D, l: FrameLayout): void {
  if (c1.value === c2.value) {
    ctx.fillStyle = c1.value
  } else {
    const g = gradientLine(l.width, l.height, angle.value)
    const grad = ctx.createLinearGradient(g.x0, g.y0, g.x1, g.y1)
    grad.addColorStop(0, c1.value)
    grad.addColorStop(1, c2.value)
    ctx.fillStyle = grad
  }
  ctx.fillRect(0, 0, l.width, l.height)
}

/** 画外壳底（带阴影） */
function paintDevice(ctx: CanvasRenderingContext2D, l: FrameLayout, fill: string): void {
  const d = l.device
  ctx.save()
  ctx.shadowColor = SHADOW_COLOR
  ctx.shadowBlur = l.shadow.blur
  ctx.shadowOffsetY = l.shadow.offsetY
  ctx.fillStyle = fill
  roundRectPath(ctx, d.x, d.y, d.w, d.h, l.deviceRadius)
  ctx.fill()
  ctx.restore()
}

/** 画浏览器顶栏（须在设备圆角裁剪内调用） */
function paintBar(ctx: CanvasRenderingContext2D, l: FrameLayout): void {
  const bar = l.bar!
  ctx.fillStyle = BAR_BG
  ctx.fillRect(bar.rect.x, bar.rect.y, bar.rect.w, bar.rect.h)
  bar.dots.forEach((d, i) => {
    ctx.fillStyle = DOT_COLORS[i]
    ctx.beginPath()
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
    ctx.fill()
  })
  const p = bar.pill
  ctx.fillStyle = PILL_BG
  roundRectPath(ctx, p.x, p.y, p.w, p.h, p.h / 2)
  ctx.fill()
  ctx.save()
  roundRectPath(ctx, p.x, p.y, p.w, p.h, p.h / 2)
  ctx.clip()
  ctx.fillStyle = PILL_TEXT
  ctx.font = `${Math.round(p.h * PILL_FONT_RATIO)}px sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText(address.value, p.x + p.h * PILL_TEXT_PAD, p.y + p.h / 2)
  ctx.restore()
}

/** 画手机缺口 */
function paintCutout(ctx: CanvasRenderingContext2D, l: FrameLayout): void {
  const c = l.cutout
  if (!c) return
  ctx.fillStyle = PHONE_BODY
  if (c.dot) {
    ctx.beginPath()
    ctx.arc(c.dot.x, c.dot.y, c.dot.r, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  // 往上多画一个圆角高度，顶部被屏幕裁剪掉，只剩下方圆角
  const r = c.rect.h / 2
  roundRectPath(ctx, c.rect.x, c.rect.y - r, c.rect.w, c.rect.h + r, r)
  ctx.fill()
}

/** 开始生成 */
async function run(): Promise<void> {
  const img = image.value
  if (!img) return
  await process([img], async (src) => {
    const bmp = await loadBitmap(src)
    const l = frameLayout(bmp.width, bmp.height, { style: style.value, padPct: padPct.value, radiusPct: radiusPct.value, cutout: cutout.value })
    const canvas = createCanvas(l.width, l.height)
    try {
      const ctx = canvas.getContext('2d')!
      paintBackground(ctx, l)
      paintDevice(ctx, l, style.value === 'phone' ? PHONE_BODY : style.value === 'browser' ? BAR_BG : '#ffffff')
      const piece = drawScaled(bmp, l.screen.w, l.screen.h)
      ctx.save()
      if (style.value === 'browser') {
        roundRectPath(ctx, l.device.x, l.device.y, l.device.w, l.device.h, l.deviceRadius)
        ctx.clip()
        paintBar(ctx, l)
      } else {
        roundRectPath(ctx, l.screen.x, l.screen.y, l.screen.w, l.screen.h, l.screenRadius)
        ctx.clip()
      }
      ctx.drawImage(piece, l.screen.x, l.screen.y, l.screen.w, l.screen.h)
      if (style.value === 'phone') paintCutout(ctx, l)
      ctx.restore()
      releaseCanvas(piece)
      const blob = await canvasToBlob(canvas, 'image/png')
      return { name: `${baseName(src.name)}${NAME_SUFFIX}.png`, blob, width: l.width, height: l.height }
    } finally {
      bmp.close()
      releaseCanvas(canvas)
    }
  })
}

onBeforeUnmount(() => image.value?.release())
</script>

<template>
  <div class="tool-page">
    <tool-group title="选择截图">
      <img v-if="image" class="thumb" :src="image.url" :alt="image.name" />
      <p v-else class="tool-hint">点底部「相册」或「拍照」选一张截图。</p>
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <van-cell title="外壳" center>
          <template #value>
            <van-radio-group v-model="style" direction="horizontal" class="is-radios">
              <van-radio name="phone">手机</van-radio>
              <van-radio name="browser">浏览器</van-radio>
              <van-radio name="card">卡片</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell v-if="style === 'phone'" title="缺口" center>
          <template #value>
            <van-radio-group v-model="cutout" direction="horizontal" class="is-radios">
              <van-radio name="none">无</van-radio>
              <van-radio name="notch">刘海</van-radio>
              <van-radio name="punch">挖孔</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-field v-if="style === 'browser'" v-model="address" label="地址栏" placeholder="显示在地址栏里的文字" />
        <van-cell title="边距" :value="`${padPct}%`" />
      </van-cell-group>
      <div class="is-slider"><van-slider v-model="padPct" :min="0" :max="25" /></div>
      <van-cell-group :border="false">
        <van-cell title="圆角" :value="`${radiusPct}%`" />
      </van-cell-group>
      <div class="is-slider"><van-slider v-model="radiusPct" :min="0" :max="12" /></div>
    </tool-group>

    <tool-group title="背景">
      <div class="presets">
        <button
          v-for="(p, i) in BG_PRESETS"
          :key="p.name"
          type="button"
          class="preset"
          :style="{ background: `linear-gradient(135deg, ${p.c1}, ${p.c2})` }"
          :aria-label="p.name"
          @click="applyPreset(i)"
        />
      </div>
      <van-cell-group :border="false">
        <van-cell title="起始色" center>
          <template #value><color-picker v-model="c1" label="起始色" /></template>
        </van-cell>
        <van-cell title="结束色" center>
          <template #value><color-picker v-model="c2" label="结束色" /></template>
        </van-cell>
        <van-cell title="渐变角度" :value="`${angle}°`" />
      </van-cell-group>
      <div class="is-slider"><van-slider v-model="angle" :min="0" :max="360" /></div>
      <p class="tool-hint">两个颜色相同就是纯色背景。</p>
      <p v-if="layout" class="tool-hint">
        预计输出 {{ layout.width }}×{{ layout.height }}
        <template v-if="layout.scale < 1">（图片太大，已缩小到 {{ Math.round(layout.scale * 100) }}%）</template>
      </p>
    </tool-group>

    <tool-group v-if="results.length" title="结果（点击预览）">
      <image-result-list :results="results" />
    </tool-group>

    <!-- 底部动作栏：相册 / 拍照选图，保存结果，主按钮生成 -->
    <bottom-actions :actions="{ save: { disabled: !results.length || saving } }" album photo main :main-text="busy ? '生成中' : '生成'" :disabled="{ album: busy, photo: busy, main: busy || !image }" @album="choose" @photo="shoot" @main="run" @save="saveAll" />
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

/* 已选截图缩略 */
.thumb {
  display: block;
  max-width: 100%;
  max-height: 180px;
  margin: 0 auto $space-3;
  border-radius: 8px;
}


/* 背景预设色块 */
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  padding-bottom: $space-3;
}

.preset {
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--c-border);
  border-radius: 50%;
}
</style>
