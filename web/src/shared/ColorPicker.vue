<script setup lang="ts">
// 取色字段：一个色块按钮，点开底部弹层，里面是预设色、饱和度/明度方块、色相条和 HEX 输入。
// 用来替换原生 <input type="color">：Android WebView 里它只弹 8 色小框，选色很难受。
import { computed, ref, watch } from 'vue'
import { COLOR_PRESETS, HUE_MAX, PERCENT_MAX, hexToHsv, hsvToHex, loupeAbove, ratioIn, readableOn, toHex6 } from './color-picker'

/** 放大镜气泡直径（像素） */
const LOUPE_SIZE = 64
/** 气泡与手指的间距（像素） */
const LOUPE_GAP = 20
/** 取色区上方可借用的空间（弹层标题），气泡可以探出这么多 */
const LOUPE_ROOM = 36

/**
 * 属性
 * - modelValue：当前颜色，`#rrggbb`，用 v-model 绑定
 * - label：无障碍名称，也是弹层标题
 *
 * @example
 * <color-picker v-model="bg" label="背景色" />
 */
const props = withDefaults(defineProps<{ modelValue: string; label?: string }>(), { label: '选择颜色' })
/** 颜色变化时触发，参数为小写 `#rrggbb` */
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

/** 弹层是否展开 */
const open = ref(false)
/** 当前 HSV；本地保存，免得灰色（饱和度 0）来回转换时丢掉色相 */
const hsv = ref(hexToHsv(props.modelValue))
/** HEX 输入框的文本 */
const hexText = ref(props.modelValue)
/** 放大镜气泡：拖动时跟着手指，显示当前颜色与 HEX，免得被手指挡住；null 表示没在拖动 */
const loupe = ref<{ target: 'sv' | 'hue'; x: number; y: number; above: boolean } | null>(null)
/** 方块与色相条的 DOM，用来换算指针位置 */
const svRef = ref<HTMLElement | null>(null)
const hueRef = ref<HTMLElement | null>(null)

/** 气泡里 HEX 的字色，保证看得清 */
const loupeText = computed(() => readableOn(current.value))
/** 当前颜色的 HEX */
const current = computed(() => hsvToHex(hsv.value))
/** 方块底色：当前色相的纯色 */
const hueColor = computed(() => hsvToHex({ h: hsv.value.h, s: PERCENT_MAX, v: PERCENT_MAX }))
/** 方块上的选中点位置（百分比） */
const svDot = computed(() => ({ left: `${hsv.value.s}%`, top: `${PERCENT_MAX - hsv.value.v}%` }))
/** 色相条上的选中点位置（百分比） */
const hueDot = computed(() => ({ left: `${(hsv.value.h / HUE_MAX) * PERCENT_MAX}%` }))

/** 外部改了颜色（且与本地不一致）时同步进来 */
watch(
  () => props.modelValue,
  (v) => {
    if (toHex6(v) === current.value) return
    hsv.value = hexToHsv(v)
    hexText.value = v
  },
)

/** 把本地颜色同步到输入框并通知外部 */
function commit(): void {
  hexText.value = current.value
  emit('update:modelValue', current.value)
}

/** 打开弹层：以当前值为准重置本地状态 */
function show(): void {
  hsv.value = toHex6(props.modelValue) === current.value ? hsv.value : hexToHsv(props.modelValue)
  hexText.value = current.value
  open.value = true
}

/**
 * 更新放大镜气泡的位置：x 夹在取色区内，色相条上固定在条的中线。
 *
 * @param ev 指针事件
 * @param target 当前拖动的是方块还是色相条
 */
function placeLoupe(ev: PointerEvent, target: 'sv' | 'hue'): void {
  const el = target === 'sv' ? svRef.value : hueRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const x = Math.min(r.width, Math.max(0, ev.clientX - r.left))
  const y = target === 'sv' ? Math.min(r.height, Math.max(0, ev.clientY - r.top)) : r.height / 2
  loupe.value = { target, x, y, above: loupeAbove(y, LOUPE_SIZE, LOUPE_GAP, LOUPE_ROOM) }
}

/**
 * 开始拖动：捕获指针，立即取一次值，之后移动时持续取值，同时显示放大镜气泡。
 *
 * @param e 指针按下事件
 * @param apply 把指针事件换成颜色变化的回调
 * @param target 拖动的是方块还是色相条
 */
function startDrag(e: PointerEvent, apply: (ev: PointerEvent) => void, target: 'sv' | 'hue'): void {
  const el = e.currentTarget as HTMLElement
  try {
    el.setPointerCapture(e.pointerId)
  } catch {
    // 指针号无效（如合成事件）时不捕获
  }
  apply(e)
  placeLoupe(e, target)
  const move = (ev: PointerEvent) => {
    apply(ev)
    placeLoupe(ev, target)
  }
  const stop = () => {
    loupe.value = null
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', stop)
    el.removeEventListener('pointercancel', stop)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', stop)
  el.addEventListener('pointercancel', stop)
}

/** 在方块上取饱和度（横）与明度（纵，上亮下暗） */
function applySv(e: PointerEvent): void {
  const el = svRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  hsv.value = {
    ...hsv.value,
    s: ratioIn(e.clientX, r.left, r.width) * PERCENT_MAX,
    v: (1 - ratioIn(e.clientY, r.top, r.height)) * PERCENT_MAX,
  }
  commit()
}

/** 在色相条上取色相 */
function applyHue(e: PointerEvent): void {
  const el = hueRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  hsv.value = { ...hsv.value, h: ratioIn(e.clientX, r.left, r.width) * HUE_MAX }
  commit()
}

/** 点预设色 */
function pickPreset(hex: string): void {
  hsv.value = hexToHsv(hex)
  commit()
}

/** HEX 输入框失焦或回车：能认出就采用，认不出就还原成当前色 */
function applyHexText(): void {
  const hex = toHex6(hexText.value)
  if (hex) {
    hsv.value = hexToHsv(hex)
    commit()
  } else {
    hexText.value = current.value
  }
}
</script>

<template>
  <button type="button" class="color-picker" :style="{ background: modelValue }" :aria-label="label" @click="show" />
  <van-popup v-model:show="open" position="bottom" round teleport="body" :style="{ maxHeight: '80%' }">
    <div class="color-picker__panel">
      <h3 class="color-picker__title">{{ label }}</h3>
      <div
        ref="svRef"
        class="color-picker__sv"
        :style="{ backgroundColor: hueColor }"
        role="slider"
        aria-label="饱和度与明度"
        @pointerdown="startDrag($event, applySv, 'sv')"
      >
        <i class="color-picker__dot" :class="{ 'is-drag': loupe?.target === 'sv' }" :style="{ ...svDot, background: current }" />
        <div v-if="loupe?.target === 'sv'" class="color-picker__loupe" :class="{ 'is-below': !loupe.above }" :style="{ left: `${loupe.x}px`, top: `${loupe.y}px`, background: current, color: loupeText }">{{ current }}</div>
      </div>
      <div ref="hueRef" class="color-picker__hue" role="slider" aria-label="色相" @pointerdown="startDrag($event, applyHue, 'hue')">
        <i class="color-picker__dot" :class="{ 'is-drag': loupe?.target === 'hue' }" :style="{ ...hueDot, background: hueColor }" />
        <div v-if="loupe?.target === 'hue'" class="color-picker__loupe" :class="{ 'is-below': !loupe.above }" :style="{ left: `${loupe.x}px`, top: `${loupe.y}px`, background: current, color: loupeText }">{{ current }}</div>
      </div>
      <div class="color-picker__row">
        <span class="color-picker__preview" :style="{ background: current }" />
        <input
          v-model="hexText"
          class="color-picker__hex"
          type="text"
          maxlength="32"
          autocapitalize="off"
          spellcheck="false"
          aria-label="HEX 颜色值"
          @blur="applyHexText"
          @keydown.enter="applyHexText"
        />
      </div>
      <div class="color-picker__presets">
        <button
          v-for="c in COLOR_PRESETS"
          :key="c"
          type="button"
          class="color-picker__preset"
          :class="{ 'is-on': current === c }"
          :style="{ background: c }"
          :aria-label="c"
          @click="pickPreset(c)"
        />
      </div>
      <van-button type="primary" block round @click="open = false">完成</van-button>
    </div>
  </van-popup>
</template>

<style lang="scss" scoped>
/* 触发按钮：与原来的原生色块同尺寸 */
.color-picker {
  width: 44px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.color-picker__panel {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  padding: $space-4;
}

.color-picker__title {
  margin: 0;
  font-size: 15px;
}

/* 饱和度/明度方块：底色是纯色相，上面叠白（左→右透明）和黑（上→下透明） */
.color-picker__sv {
  position: relative;
  height: 180px;
  border-radius: 8px;
  background-image: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent);
  touch-action: none;
}

/* 色相条 */
.color-picker__hue {
  position: relative;
  height: 20px;
  border-radius: 10px;
  background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  touch-action: none;
}

/* 选中点：白边小圆点；色相条上垂直居中 */
.color-picker__dot {
  position: absolute;
  width: 18px;
  height: 18px;
  margin: -9px 0 0 -9px;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}

.color-picker__hue .color-picker__dot {
  top: 50%;
}

/* 拖动时选中点放大一点，更像放大镜的焦点 */
.color-picker__dot.is-drag {
  transform: scale(1.4);
}

/* 放大镜气泡：圆形、白边、投影，跟着手指显示当前颜色与 HEX；默认在手指上方，上方放不下翻到下方 */
.color-picker__loupe {
  position: absolute;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  margin: -84px 0 0 -32px; /* 圆心在手指上方：-(直径 + 间距) */
  border: 3px solid #fff;
  border-radius: 50%;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  font-family: monospace;
  font-size: 11px;
  font-weight: 600;
  pointer-events: none;

  &.is-below {
    margin-top: 20px; /* 翻到手指下方 */
  }
}

.color-picker__row {
  display: flex;
  align-items: center;
  gap: $space-3;
}

.color-picker__preview {
  flex: none;
  width: 36px;
  height: 36px;
  border: 1px solid var(--c-border);
  border-radius: 8px;
}

.color-picker__hex {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 $space-3;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: transparent;
  color: var(--c-text);
  font-family: monospace;
  font-size: 15px;
}

.color-picker__presets {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

.color-picker__preset {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  box-shadow: 0 0 0 1px var(--c-border);
  -webkit-tap-highlight-color: transparent;

  &.is-on {
    border-color: var(--c-text);
  }
}
</style>
