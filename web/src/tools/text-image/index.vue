<script setup lang="ts">
// 文字转图：输入文字排版成图片，自动换行，超过高度上限自动分页成多张
import BottomActions from '@/shared/BottomActions.vue'
import ColorPicker from '@/shared/ColorPicker.vue'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { computed, ref } from 'vue'
import { showToast } from 'vant'
import ImageResultList from '@/shared/ImageResultList.vue'
import { useImageResults } from '@/shared/useImageResults'
import { canvasToBlob, createCanvas, releaseCanvas } from '@/shared/image-io'
import { alignX, BG_PRESETS, footerFontSize, footerHeight, gradientLine, layoutPages, type LayoutOptions, type Page, type TextAlign } from './logic'

/** 系统字体栈，不打包字体 */
const FONT_FAMILY = '-apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'
/** 宽度预设 */
const WIDTH_OPTIONS = [750, 1080, 1440]
/** 宽度选择器选项 */
const WIDTH_PICK_OPTIONS: CellOption[] = WIDTH_OPTIONS.map((w) => ({ value: w, label: String(w) }))
/** 对齐方式选项 */
const ALIGN_OPTIONS: CellOption[] = [
  { value: 'left', label: '靠左' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '靠右' },
]
/** 单张高度上限预设：0 为只受画布上限约束 */
const CAP_OPTIONS = [
  { text: '不限（受画布上限）', value: 0 },
  { text: '4096', value: 4096 },
  { text: '2048', value: 2048 },
]
/** 渐变角度 */
const GRADIENT_ANGLE = 135
/** 页脚文字透明度 */
const FOOTER_ALPHA = 0.55
/** 输出文件名前缀 */
const NAME_PREFIX = 'text'

/** 输入文字 */
const text = ref('')
/** 宽度 */
const width = ref(1080)
/** 字号 */
const fontSize = ref(44)
/** 行距倍数 */
const lineHeight = ref(1.7)
/** 内边距 */
const padding = ref(72)
/** 对齐 */
const align = ref<TextAlign>('left')
/** 文字色 */
const color = ref(BG_PRESETS[0].text)
/** 背景起止色 */
const c1 = ref(BG_PRESETS[0].c1)
const c2 = ref(BG_PRESETS[0].c2)
/** 页脚水印文字 */
const footer = ref('')
/** 单张高度上限 */
const heightCap = ref(0)
/** 结果与批处理状态 */
const { results, busy, saving, process, saveAll, clear } = useImageResults()

/** 当前字体设置 */
const fontCss = computed(() => `${fontSize.value}px ${FONT_FAMILY}`)

/** 套用背景预设（连同配套文字色） */
function applyPreset(i: number): void {
  const p = BG_PRESETS[i]
  c1.value = p.c1
  c2.value = p.c2
  color.value = p.text
}

/** 生成一页画布 */
function drawPage(page: Page, opts: LayoutOptions): HTMLCanvasElement {
  const canvas = createCanvas(page.width, page.height)
  const ctx = canvas.getContext('2d')!
  if (c1.value === c2.value) {
    ctx.fillStyle = c1.value
  } else {
    const g = gradientLine(page.width, page.height, GRADIENT_ANGLE)
    const grad = ctx.createLinearGradient(g.x0, g.y0, g.x1, g.y1)
    grad.addColorStop(0, c1.value)
    grad.addColorStop(1, c2.value)
    ctx.fillStyle = grad
  }
  ctx.fillRect(0, 0, page.width, page.height)
  ctx.font = fontCss.value
  ctx.fillStyle = color.value
  ctx.textBaseline = 'middle'
  const lineH = Math.round(opts.fontSize * opts.lineHeightRatio)
  const contentW = page.width - opts.padding * 2
  page.lines.forEach((line, i) => {
    if (!line) return
    const x = alignX(align.value, opts.padding, contentW, ctx.measureText(line).width)
    ctx.fillText(line, x, opts.padding + i * lineH + lineH / 2)
  })
  if (opts.footer) {
    const fs = footerFontSize(opts.fontSize)
    const fh = footerHeight(opts.fontSize, opts.footer)
    ctx.font = `${fs}px ${FONT_FAMILY}`
    ctx.globalAlpha = FOOTER_ALPHA
    ctx.textAlign = 'center'
    ctx.fillText(opts.footer, page.width / 2, page.height - opts.padding - fh / 2)
    ctx.globalAlpha = 1
  }
  return canvas
}

/** 开始生成 */
async function run(): Promise<void> {
  if (!text.value.trim()) {
    showToast('先输入点文字')
    return
  }
  const opts: LayoutOptions = {
    width: width.value,
    fontSize: fontSize.value,
    lineHeightRatio: lineHeight.value,
    padding: padding.value,
    heightCap: heightCap.value,
    footer: footer.value.trim(),
  }
  // 用一块小画布量字宽，字体须与绘制时一致
  const probe = createCanvas(1, 1)
  const pctx = probe.getContext('2d')!
  pctx.font = fontCss.value
  const pages = layoutPages(text.value, opts, (s) => pctx.measureText(s).width)
  releaseCanvas(probe)
  const stamp = Date.now()
  await process(pages, async (page, i) => {
    const canvas = drawPage(page, opts)
    try {
      const blob = await canvasToBlob(canvas, 'image/png')
      const no = pages.length > 1 ? `_${i + 1}` : ''
      return { name: `${NAME_PREFIX}_${stamp}${no}.png`, blob, width: page.width, height: page.height }
    } finally {
      releaseCanvas(canvas)
    }
  })
}
</script>

<template>
  <div class="tool-page">
    <tool-group title="文字内容">
      <van-field v-model="text" type="textarea" rows="6" autosize placeholder="输入或粘贴要转成图片的文字" @update:model-value="clear" />
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <cell-picker v-model="width" title="宽度" :options="WIDTH_PICK_OPTIONS" />
        <cell-picker :model-value="align" title="对齐" :options="ALIGN_OPTIONS" @update:model-value="align = $event as TextAlign" />
        <van-cell title="字号" :value="`${fontSize} px`" />
      </van-cell-group>
      <div class="is-slider"><van-slider v-model="fontSize" :min="20" :max="96" /></div>
      <van-cell-group :border="false">
        <van-cell title="行距" :value="`${lineHeight} 倍`" />
      </van-cell-group>
      <div class="is-slider"><van-slider v-model="lineHeight" :min="1" :max="2.4" :step="0.1" /></div>
      <van-cell-group :border="false">
        <van-cell title="内边距" :value="`${padding} px`" />
      </van-cell-group>
      <div class="is-slider"><van-slider v-model="padding" :min="0" :max="200" /></div>
    </tool-group>

    <tool-group title="配色">
      <div class="presets">
        <button
          v-for="(p, i) in BG_PRESETS"
          :key="p.name"
          type="button"
          class="preset"
          :style="{ background: `linear-gradient(135deg, ${p.c1}, ${p.c2})`, color: p.text }"
          @click="applyPreset(i)"
        >
          {{ p.name }}
        </button>
      </div>
      <van-cell-group :border="false">
        <van-cell title="背景色" center>
          <template #value><color-picker v-model="c1" label="背景起始色" /></template>
        </van-cell>
        <van-cell title="渐变到" center>
          <template #value><color-picker v-model="c2" label="背景结束色" /></template>
        </van-cell>
        <van-cell title="文字色" center>
          <template #value><color-picker v-model="color" label="文字色" /></template>
        </van-cell>
      </van-cell-group>
      <p class="tool-hint">背景两个颜色相同就是纯色。</p>
    </tool-group>

    <tool-group>
      <van-field v-model="footer" label="页脚水印" placeholder="可选，显示在每张图底部" maxlength="40" />
      <van-cell title="单张高度上限" center>
        <template #value>
          <select v-model.number="heightCap" class="is-select" aria-label="单张高度上限">
            <option v-for="o in CAP_OPTIONS" :key="o.value" :value="o.value">{{ o.text }}</option>
          </select>
        </template>
      </van-cell>
      <p class="tool-hint">文字太长放不下时，会自动拆成多张图。</p>
    </tool-group>

    <tool-group v-if="results.length" :title="`结果（共 ${results.length} 张，点击预览）`">
      <image-result-list :results="results" />
    </tool-group>

    <!-- 底部动作栏：保存结果，主按钮生成图片 -->
    <bottom-actions :actions="{ save: { disabled: !results.length || saving } }" main :main-text="busy ? '生成中' : '生成图片'" :disabled="{ main: busy }" @main="run" @save="saveAll" />
  </div>
</template>

<style lang="scss" scoped>
/* 滑杆留出触控空间 */
.is-slider {
  padding: $space-2 $space-3 $space-3;
}


/* 配色预设 */
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  padding-bottom: $space-3;
}

.preset {
  padding: 6px 12px;
  border: 1px solid var(--c-border);
  border-radius: 16px;
  font-size: 13px;
}

/* 原生下拉 */
.is-select {
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  color: inherit;
  background: transparent;
}
</style>
