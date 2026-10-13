<script setup lang="ts">
// 颜色转换：输入任一写法，得到 HEX / RGB / HSL / HSV；三条滑杆可微调 RGB
import { computed, ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { formatColor, parseColor, readableOn, type Rgba } from './logic'

/** 初始颜色 */
const INITIAL = '#3B6CF6'
/** RGB 通道及滑杆颜色（通道色是内容色，不随主题变） */
const CHANNELS = [
  { key: 'r', color: '#ee0a24' },
  { key: 'g', color: '#07c160' },
  { key: 'b', color: '#1989fa' },
] as const

/** 输入框文本 */
const text = ref(INITIAL)
/** 最近一次解析成功的颜色（输入非法时预览保留它） */
const last = ref<Rgba>({ r: 59, g: 108, b: 246, a: 1 })

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

/** 复制某一行 */
async function copy(value: string): Promise<void> {
  if (await copyText(value)) showSuccessToast(`已复制 ${value}`)
  else showFailToast('复制失败，请长按文字手动选择')
}
</script>

<template>
  <div class="tool-page">
    <div class="preview" :style="previewStyle">{{ formats.hex }}</div>

    <div class="tool-card">
      <h3 class="tool-card__title">输入颜色</h3>
      <van-field
        v-model="text"
        clearable
        autocomplete="off"
        :spellcheck="false"
        placeholder="#3b6cf6 / rgb(59,108,246) / hsl(224,91%,60%)"
        :error-message="error"
      />
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">微调 RGB</h3>
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
    </div>

    <div class="tool-card">
      <van-cell-group :border="false">
        <van-cell v-for="r in rows" :key="r.label" center :title-style="{ flex: '0 0 44px' }">
          <template #title><span class="row__k">{{ r.label }}</span></template>
          <template #value><code class="row__v">{{ r.value }}</code></template>
          <template #right-icon>
            <van-button size="small" plain icon="description-o" class="row__copy" @click="copy(r.value)">复制</van-button>
          </template>
        </van-cell>
      </van-cell-group>
    </div>
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
