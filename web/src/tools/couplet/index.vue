<script setup lang="ts">
// 对联生成：从自编对联库按主题、字数挑选；也可手写上下联和横批，画成红底金字的竖排对联图并导出 PNG
import { computed, nextTick, ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { canvasToBlob, saveBlob } from '@/shared/image-io'
import { COUPLETS, THEMES, type Couplet, type ThemeId } from './data'
import {
  customWarnings,
  drawCouplet,
  filterByLength,
  layoutCouplet,
  LENGTH_OPTIONS,
  randomCouplet,
  THEME_IDS,
  themeCouplets,
} from './logic'

/** 导出文件名 */
const FILE_NAME = 'couplet.png'

/** 当前主题 */
const theme = ref<ThemeId>('spring')
/** 字数筛选，0 为不限 */
const length = ref(0)
/** 当前这副 */
const current = ref<Couplet | null>(randomCouplet(themeCouplets('spring')))

/** 手写：上联 */
const up = ref('')
/** 手写：下联 */
const down = ref('')
/** 手写：横批 */
const banner = ref('')
/** 画布 */
const canvas = ref<HTMLCanvasElement | null>(null)
/** 保存中 */
const saving = ref(false)

/** 当前主题加字数筛选后的候选 */
const candidates = computed(() => filterByLength(themeCouplets(theme.value), length.value))
/** 手写内容是否可预览 */
const canPreview = computed(() => !!up.value.trim() && !!down.value.trim())
/** 手写软提示 */
const warnings = computed(() => customWarnings(up.value.trim(), down.value.trim(), banner.value.trim()))

/** 换一副：同主题同筛选内避开当前这副 */
function next(): void {
  current.value = randomCouplet(candidates.value, current.value)
}

/** 随机一副：从整个库里抽，并切到它所属主题 */
function randomAll(): void {
  const all = THEME_IDS.flatMap((t) => COUPLETS[t])
  const p = randomCouplet(all, current.value)
  if (!p) return
  const t = THEME_IDS.find((id) => COUPLETS[id].includes(p))
  if (t) theme.value = t
  length.value = 0
  current.value = p
}

/** 切主题或字数后立刻换一副 */
watch([theme, length], next)

/** 把当前这副填进手写区，方便微调后导出 */
function useCurrent(): void {
  if (!current.value) return
  up.value = current.value.up
  down.value = current.value.down
  banner.value = current.value.banner
}

/** 复制当前这副文字 */
async function copyCurrent(): Promise<void> {
  const p = current.value
  if (!p) return
  const ok = await copyText(`上联：${p.up}\n下联：${p.down}\n横批：${p.banner}`)
  if (ok) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}

/** 重绘手写对联 */
async function redraw(): Promise<void> {
  await nextTick()
  const el = canvas.value
  if (!el || !canPreview.value) return
  const layout = layoutCouplet(up.value.trim(), down.value.trim(), banner.value.trim())
  // 先设宽高（会清空画布）再画
  el.width = layout.width
  el.height = layout.height
  const ctx = el.getContext('2d')
  if (ctx) drawCouplet(ctx, layout)
}
watch([up, down, banner], redraw, { flush: 'post' })

/** 导出 PNG */
async function save(): Promise<void> {
  if (!canvas.value || !canPreview.value) return
  saving.value = true
  try {
    const res = await saveBlob(await canvasToBlob(canvas.value, 'image/png'), FILE_NAME)
    showSuccessToast(res.mode === 'native' ? '已保存到相册' : '已开始下载')
  } catch {
    showFailToast('保存失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">选一副</h3>
      <van-radio-group v-model="theme" direction="horizontal" class="cp-gap">
        <van-radio v-for="t in THEMES" :key="t.id" :name="t.id">{{ t.label }}</van-radio>
      </van-radio-group>
      <van-radio-group v-model="length" direction="horizontal" class="cp-gap">
        <van-radio :name="0">不限字数</van-radio>
        <van-radio v-for="n in LENGTH_OPTIONS" :key="n" :name="n">{{ n }} 字</van-radio>
      </van-radio-group>
      <div v-if="current" class="cp-show">
        <p class="cp-line">上联：{{ current.up }}</p>
        <p class="cp-line">下联：{{ current.down }}</p>
        <p class="cp-line">横批：{{ current.banner }}</p>
      </div>
      <p v-else class="tool-hint">这个字数下该主题暂时没有对联，换个字数试试</p>
      <div class="tool-actions">
        <van-button type="primary" @click="randomAll">随机一副</van-button>
        <van-button :disabled="!candidates.length" @click="next">换一副</van-button>
        <van-button :disabled="!current" @click="copyCurrent">复制</van-button>
        <van-button :disabled="!current" @click="useCurrent">拿去做图</van-button>
      </div>
      <p class="tool-hint">库内为自编对联，数量有限。</p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">手写对联预览</h3>
      <van-field v-model="up" label="上联" placeholder="如：春风送暖千山绿" />
      <van-field v-model="down" label="下联" placeholder="如：瑞雪兆丰万户欢" />
      <van-field v-model="banner" label="横批" placeholder="四个字，可不填" />
      <p v-for="w in warnings" :key="w" class="tool-hint">提示：{{ w }}</p>
      <div v-if="canPreview" class="cp-preview">
        <canvas ref="canvas" class="cp-canvas" />
      </div>
      <p v-else class="tool-hint">填好上下联后，对联图会显示在这里</p>
      <div class="tool-actions">
        <van-button type="primary" :disabled="!canPreview" :loading="saving" @click="save">导出 PNG</van-button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.cp-gap {
  margin: $space-2 0;
}
/* 当前对联展示 */
.cp-show {
  margin: $space-3 0;
  padding: $space-3;
  color: #ffd54a;
  background: #c8102e;
  border-radius: 6px;
}
.cp-line {
  margin: $space-1 0;
  font-size: 18px;
  letter-spacing: 2px;
}
.cp-preview {
  display: flex;
  justify-content: center;
  margin: $space-3 0;
}
.cp-canvas {
  max-width: 100%;
  height: auto;
}
</style>
