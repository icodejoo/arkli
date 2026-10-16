<script setup lang="ts">
// 颜色助手：转换（HEX / RGB / HSL / HSV）、WCAG 对比度、HSL 配色三个分区
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import ColorFullscreen from '@/shared/ColorFullscreen.vue'
import {
  buildPalette, colorFromQuery, contrastRatio, formatColor, parseColor, readableOn, SCHEME_LABEL, wcagLevels, type PaletteScheme, type Rgba,
} from './logic'

/** 初始颜色 */
const INITIAL = '#3B6CF6'
/** RGB 通道及滑杆颜色（通道色是内容色，不随主题变） */
const CHANNELS = [
  { key: 'r', color: '#ee0a24' },
  { key: 'g', color: '#07c160' },
  { key: 'b', color: '#1989fa' },
] as const

/** 分区：转换 / 对比度 / 配色 */
const tab = ref<'convert' | 'contrast' | 'palette'>('convert')
/** 配色方案列表 */
const SCHEMES = Object.keys(SCHEME_LABEL) as PaletteScheme[]
/** 对比度默认前景色 */
const DEFAULT_FG = '#1B1D22'
/** 对比度默认背景色 */
const DEFAULT_BG = '#FFFFFF'
/** 对比度判定项：标签与取值字段 */
const LEVEL_ROWS = [
  { label: 'AA 普通文字（≥ 4.5）', key: 'aaNormal' },
  { label: 'AA 大号文字（≥ 3）', key: 'aaLarge' },
  { label: 'AAA 普通文字（≥ 7）', key: 'aaaNormal' },
  { label: 'AAA 大号文字（≥ 4.5）', key: 'aaaLarge' },
] as const

/** 路由：别的工具（如取色器）会带 ?c=HEX 过来 */
const route = useRoute()
/** 输入框文本：有合法的 ?c= 就用它，否则用初始色 */
const text = ref(colorFromQuery(route.query.c) ?? INITIAL)
/** 全屏展示颜色的弹层是否显示 */
const fullShow = ref(false)
/** 最近一次解析成功的颜色（输入非法时预览保留它） */
const last = ref<Rgba>((() => {
  const p = parseColor(text.value)
  return p.ok ? p.color : { r: 59, g: 108, b: 246, a: 1 }
})())

/** 当前解析结果 */
const parsed = computed(() => parseColor(text.value))
/** 错误提示 */
const error = computed(() => (parsed.value.ok ? '' : parsed.value.error))
/** 当前有效颜色 */
const color = computed<Rgba>(() => (parsed.value.ok ? parsed.value.color : last.value))
/** 各格式输出 */
const formats = computed(() => formatColor(color.value))
/** 输出行：标签与值 */
const rows = computed(() => [
  { label: 'HEX', value: formats.value.hex },
  { label: 'RGB', value: formats.value.rgb },
  { label: 'HSL', value: formats.value.hsl },
  { label: 'HSV', value: formats.value.hsv },
])
/** 全屏展示用的 HEX（不带透明度） */
const fullHex = computed(() => formatColor({ ...color.value, a: 1 }).hex)
/** 预览样式 */
const previewStyle = computed(() => ({
  background: `rgba(${Math.round(color.value.r)}, ${Math.round(color.value.g)}, ${Math.round(color.value.b)}, ${color.value.a})`,
  color: readableOn(color.value),
}))

// 解析成功时记下颜色，输入非法时预览保留它
watch(parsed, (p) => {
  if (p.ok) last.value = p.color
})

/**
 * 滑杆改某个通道：直接改写成 HEX 填回输入框。
 *
 * @param key 通道名
 * @param v 滑杆新值
 */
function setChannel(key: 'r' | 'g' | 'b', v: number): void {
  const next = { ...color.value, [key]: v }
  last.value = next
  text.value = formatColor(next).hex
}

/** 前景色输入 */
const fgText = ref(DEFAULT_FG)
/** 背景色输入 */
const bgText = ref(DEFAULT_BG)
/** 前景解析 */
const fgParsed = computed(() => parseColor(fgText.value))
/** 背景解析 */
const bgParsed = computed(() => parseColor(bgText.value))
/** 对比度结果；任一颜色非法时为空 */
const contrast = computed(() => {
  if (!fgParsed.value.ok || !bgParsed.value.ok) return null
  const ratio = contrastRatio(fgParsed.value.color, bgParsed.value.color)
  return { ratio, text: ratio.toFixed(2), levels: wcagLevels(ratio) }
})
/** 对比度预览样式；非法时回退到默认色 */
const contrastStyle = computed(() => ({
  color: fgParsed.value.ok ? formatColor({ ...fgParsed.value.color, a: 1 }).hex : DEFAULT_FG,
  background: bgParsed.value.ok ? formatColor({ ...bgParsed.value.color, a: 1 }).hex : DEFAULT_BG,
}))

/** 前景背景互换 */
function swapContrast(): void {
  const t = fgText.value
  fgText.value = bgText.value
  bgText.value = t
}

/** 当前选中的配色方案 */
const scheme = ref<PaletteScheme>('complementary')
/** 配色结果：每个色块带 HEX 与文字色 */
const swatches = computed(() =>
  buildPalette(color.value, scheme.value).map((c) => ({ hex: formatColor(c).hex, fg: readableOn(c) })),
)

/** 点击色块：复制 HEX */
async function copyHex(hex: string): Promise<void> {
  await copy(hex)
}

/** 复制某一行 */
async function copy(value: string): Promise<void> {
  if (await copyText(value)) showSuccessToast(`已复制 ${value}`)
  else showFailToast('复制失败，请长按文字手动选择')
}
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="tab" type="card">
      <van-tab title="转换" name="convert" />
      <van-tab title="对比度" name="contrast" />
      <van-tab title="配色" name="palette" />
    </van-tabs>

    <template v-if="tab === 'contrast'">
      <div class="preview" :style="contrastStyle">
        <span v-if="contrast">{{ contrast.text }} : 1</span>
        <span v-else>颜色写法有误</span>
      </div>
      <tool-group title="前景色（文字）">
        <van-field v-model="fgText" clearable autocomplete="off" :spellcheck="false" placeholder="#1b1d22" :error-message="fgParsed.ok ? '' : fgParsed.error" />
        <h3 class="tool-group__title cc-gap">背景色</h3>
        <van-field v-model="bgText" clearable autocomplete="off" :spellcheck="false" placeholder="#ffffff" :error-message="bgParsed.ok ? '' : bgParsed.error" />
        <van-button class="cc-gap" size="small" plain @click="swapContrast">前景背景互换</van-button>
      </tool-group>
      <tool-group v-if="contrast">
        <van-cell-group :border="false">
          <van-cell v-for="r in LEVEL_ROWS" :key="r.key" :title="r.label" center>
            <template #value>
              <van-tag :type="contrast.levels[r.key] ? 'success' : 'danger'">{{ contrast.levels[r.key] ? '通过' : '不通过' }}</van-tag>
            </template>
          </van-cell>
        </van-cell-group>
        <p class="tool-hint cc-gap">大号文字指 18pt（24px）以上，或 14pt（约 19px）以上加粗。半透明颜色按不透明计算。</p>
      </tool-group>
    </template>

    <template v-else-if="tab === 'palette'">
      <tool-group title="基色">
        <van-field v-model="text" clearable autocomplete="off" :spellcheck="false" placeholder="#3b6cf6" :error-message="error" />
        <h3 class="tool-group__title cc-gap">方案</h3>
        <van-radio-group v-model="scheme" direction="horizontal">
          <van-radio v-for="s in SCHEMES" :key="s" :name="s">{{ SCHEME_LABEL[s] }}</van-radio>
        </van-radio-group>
      </tool-group>
      <div class="swatches">
        <button v-for="(s, i) in swatches" :key="i" type="button" class="swatch" :style="{ background: s.hex, color: s.fg }" @click="copyHex(s.hex)">
          {{ s.hex }}
        </button>
      </div>
      <p class="tool-hint">点色块复制 HEX。配色基于 HSL，保持基色的饱和度与亮度。</p>
    </template>

    <template v-else>
    <div class="preview preview--tap" :style="previewStyle" role="button" aria-label="全屏显示颜色" @click="fullShow = true">{{ formats.hex }}</div>
    <p class="tool-hint cc-center">点上面的色块全屏显示</p>
    <color-fullscreen v-model="fullShow" :color="fullHex" />

    <tool-group title="输入颜色">
      <van-field
        v-model="text"
        clearable
        autocomplete="off"
        :spellcheck="false"
        placeholder="#3b6cf6 / rgb(59,108,246) / hsl(224,91%,60%)"
        :error-message="error"
      />
    </tool-group>

    <tool-group title="微调 RGB">
      <div v-for="c in CHANNELS" :key="c.key" class="channel">
        <b class="channel__k">{{ c.key.toUpperCase() }}</b>
        <van-slider
          class="channel__bar"
          :model-value="Math.round(color[c.key])"
          :min="0"
          :max="255"
          :active-color="c.color"
          @update:model-value="setChannel(c.key, $event)"
        />
        <span class="channel__v">{{ Math.round(color[c.key]) }}</span>
      </div>
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <van-cell v-for="r in rows" :key="r.label" center :title-style="{ flex: '0 0 44px' }">
          <template #title><span class="row__k">{{ r.label }}</span></template>
          <template #value><code class="row__v">{{ r.value }}</code></template>
          <template #right-icon>
            <van-button size="small" plain icon="description-o" class="row__copy" @click="copy(r.value)">复制</van-button>
          </template>
        </van-cell>
      </van-cell-group>
    </tool-group>
    </template>
  </div>
</template>

<style lang="scss" scoped>
/* 颜色预览块：背景是用户选的内容色 */
.preview {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 112px;
  border: 1px solid var(--c-border);
  border-radius: var(--tool-card-radius);
  font: 600 20px ui-monospace, Menlo, Consolas, monospace;
}

/* 可点的预览块（全屏显示） */
.preview--tap {
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.cc-center {
  text-align: center;
}

/* 对比度页里卡片内的间距 */
.cc-gap {
  margin-top: $space-3;
}

/* 配色色块区 */
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

/* 单个色块：背景是内容色，文字色按亮度自动挑 */
.swatch {
  flex: 1 1 80px;
  height: 88px;
  border: 1px solid var(--c-border);
  border-radius: var(--tool-card-radius);
  font: 600 14px ui-monospace, Menlo, Consolas, monospace;
}

/* 通道滑杆一行 */
.channel {
  display: flex;
  align-items: center;
  gap: $space-3;
  padding: $space-2 0;

  &__k {
    width: 16px;
    color: var(--c-text-muted);
  }

  &__bar {
    flex: 1;
  }

  &__v {
    width: 32px;
    text-align: right;
    color: var(--c-text-muted);
    font-size: 13px;
  }
}

/* 输出行 */
.row {
  &__k {
    color: var(--c-text-muted);
    font-size: 13px;
  }

  &__v {
    font: 14px ui-monospace, Menlo, Consolas, monospace;
    word-break: break-all;
    color: var(--c-text);
  }

  &__copy {
    margin-left: $space-2;
    flex-shrink: 0;
  }
}
</style>
