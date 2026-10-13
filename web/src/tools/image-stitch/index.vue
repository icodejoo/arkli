<script setup lang="ts">
// 图片拼接：纵/横拼，间距、背景色、对齐、统一宽/高，多图可排序
import { computed, onBeforeUnmount, ref } from 'vue'
import { showToast } from 'vant'
import ImageThumbList from '@/shared/ImageThumbList.vue'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { exceedsCanvas, FORMAT_MIME, stitchLayout, type StitchAlign, type StitchDirection } from '@/shared/image-calc'
import { canvasToBlob, createCanvas, drawScaled, loadBitmap, pickImages, releaseCanvas, type PickedImage } from '@/shared/image-io'

/** 最多拼接张数 */
const MAX_PICK = 20
/** 间距上限（像素） */
const GAP_MAX = 200
/** 输出 JPEG 质量 */
const JPEG_QUALITY = 0.92
/** 默认背景色 */
const BG_DEFAULT = '#ffffff'
/** 输出文件名前缀 */
const NAME_PREFIX = 'stitch'

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
const format = ref<'png' | 'jpeg'>('png')
/** 结果与批处理状态 */
const { results, busy, progress, saving, process, saveAll, clear } = useImageResults()

/** 当前设置下的拼接布局（用已知宽高估算，不解码） */
const layout = computed(() =>
  stitchLayout(images.value.map((i) => ({ width: i.width, height: i.height })), {
    direction: direction.value,
    gap: gap.value,
    unify: unify.value,
    align: align.value,
  }),
)
/** 是否超出画布上限 */
const tooBig = computed(() => layout.value.width > 0 && exceedsCanvas(layout.value.width, layout.value.height))
/** 统一宽/高的轴向文案 */
const unifyLabel = computed(() => (direction.value === 'v' ? '统一宽度' : '统一高度'))

/** 添加图片 */
async function add(): Promise<void> {
  const room = MAX_PICK - images.value.length
  if (room <= 0) {
    showToast(`最多 ${MAX_PICK} 张`)
    return
  }
  try {
    const got = await pickImages({ multiple: true, max: room, onFailed: (f) => showToast(`${f.length} 张读取失败：${f[0].message}`) })
    images.value = images.value.concat(got)
    clear()
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 移除第 i 张 */
function remove(i: number): void {
  images.value[i].release()
  images.value.splice(i, 1)
  clear()
}

/** 把第 i 张移动 delta 位 */
function move(i: number, delta: number): void {
  const j = i + delta
  if (j < 0 || j >= images.value.length) return
  const [it] = images.value.splice(i, 1)
  images.value.splice(j, 0, it)
  clear()
}

/** 开始拼接：逐张解码绘制，用完即关位图，降低内存峰值 */
async function run(): Promise<void> {
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

onBeforeUnmount(() => images.value.forEach((i) => i.release()))
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">选择图片（2~{{ MAX_PICK }} 张，可调整顺序）</h3>
      <image-thumb-list :images="images" sortable @remove="remove" @move="move" />
      <van-button block plain round :disabled="busy" @click="add">{{ images.length ? '继续添加' : '选择图片' }}</van-button>
    </div>

    <div class="tool-card">
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
          <template #value><input v-model="bg" class="is-color" type="color" aria-label="背景色" /></template>
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
      <p v-if="layout.width" class="tool-hint" :class="{ 'is-warn': tooBig }">
        预计输出 {{ layout.width }}×{{ layout.height }}
        <template v-if="tooBig">，超出上限，请减少图片、开启{{ unifyLabel }}或调小间距</template>
      </p>
    </div>

    <van-button type="primary" block round :loading="busy" :disabled="images.length < 2 || tooBig" @click="run">
      {{ busy ? `拼接中 ${progress}` : '开始拼接' }}
    </van-button>

    <div v-if="results.length" class="tool-card">
      <h3 class="tool-card__title">结果</h3>
      <image-result-list :results="results" />
      <van-button type="primary" plain block round :loading="saving" @click="saveAll">保存</van-button>
    </div>
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

/* 颜色选择框 */
.is-color {
  width: 44px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: none;
}

/* 超限警告 */
.is-warn {
  color: var(--c-error);
}
</style>
