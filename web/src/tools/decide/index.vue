<script setup lang="ts">
// 做个决定：转盘形态。选项存本地；先抽出结果再让转盘转到对应扇区
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { prefersReducedMotion } from '@/shared/motion'
import { parseOptions } from '@/shared/options'
import { MAX_SLICES, MIN_SLICES, spinWheel, wheelGradient } from './logic'

/** localStorage 键 */
const STORAGE_KEY = 'arkli:decide:text'
/** 默认选项：给第一次打开的人一个能直接转的例子 */
const DEFAULT_TEXT = '去\n不去'
/** 半圈角度 */
const HALF_TURN = 180
/** 转盘动画时长（毫秒），要和样式里的 transition 一致 */
const SPIN_MS = 4000

/** 读取上次输入 */
function load(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_TEXT
  } catch {
    return DEFAULT_TEXT
  }
}

/** 选项输入 */
const text = ref(load())
/** 转盘累计角度 */
const angle = ref(0)
/** 是否在转 */
const spinning = ref(false)
/** 中选项（null 表示还没转） */
const chosen = ref<string | null>(null)
/** 定时器句柄 */
let timer: ReturnType<typeof setTimeout> | undefined

/** 解析后的选项 */
const parsed = computed(() => parseOptions(text.value))
/** 转盘上实际展示的选项（最多 MAX_SLICES 个） */
const items = computed(() => parsed.value.items.slice(0, MAX_SLICES))
/** 提示：选项过少或过多 */
const tip = computed(() => {
  if (items.value.length < MIN_SLICES) return `至少需要 ${MIN_SLICES} 个选项`
  if (parsed.value.items.length > MAX_SLICES) return `转盘最多 ${MAX_SLICES} 项，多出的已忽略`
  return ''
})
/** 能否开转 */
const canSpin = computed(() => items.value.length >= MIN_SLICES && !spinning.value)
/** 转盘背景 */
const wheelBg = computed(() => (items.value.length >= MIN_SLICES ? wheelGradient(items.value.length) : 'var(--c-surface-active)'))
/** 转盘旋转样式 */
const wheelStyle = computed(() => ({ background: wheelBg.value, transform: `rotate(${angle.value}deg)` }))

// 选项变化时存盘，并清掉旧结果
watch(text, (v) => {
  chosen.value = null
  try {
    localStorage.setItem(STORAGE_KEY, v)
  } catch {
    // 忽略
  }
})

/**
 * 第 i 个扇区中心线的角度（自正上方顺时针）。
 *
 * @param i 扇区下标
 * @returns 角度（度）
 */
function centerAngle(i: number): number {
  return ((i + 0.5) * 360) / items.value.length
}

/**
 * 第 i 个标签外层的旋转样式：整块转到扇区中心线上。
 *
 * @param i 扇区下标
 * @returns 内联样式
 */
function spokeStyle(i: number): Record<string, string> {
  return { transform: `rotate(${centerAngle(i)}deg)` }
}

/**
 * 标签文字是否需要翻转：转盘下半圈的文字会倒着，翻 180 度保证可读。
 *
 * @param i 扇区下标
 * @returns 需要翻转时为 true
 */
function isFlipped(i: number): boolean {
  return centerAngle(i) > HALF_TURN
}

/** 开转：结果先定，再让转盘转过去 */
function spin(): void {
  if (!canSpin.value) return
  const r = spinWheel(items.value.length, angle.value)
  chosen.value = null
  spinning.value = true
  angle.value = r.angle
  const done = () => {
    chosen.value = items.value[r.index]
    spinning.value = false
  }
  if (prefersReducedMotion()) done()
  else timer = setTimeout(done, SPIN_MS)
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="tool-page">
    <div class="tool-card wheel-card">
      <div class="stage">
        <div class="pointer" />
        <div class="wheel" :style="wheelStyle">
          <span v-for="(it, i) in items" :key="it" class="spoke" :style="spokeStyle(i)">
            <span class="label" :class="{ 'label--flip': isFlipped(i) }">{{ it }}</span>
          </span>
        </div>
      </div>
      <p class="wheel-card__result" aria-live="polite">{{ spinning ? '转转转…' : chosen ? `就决定是：${chosen}` : '点下面的按钮开转' }}</p>
    </div>

    <van-button type="primary" block round :disabled="!canSpin" @click="spin">转！</van-button>
    <p v-if="tip" class="tool-hint">{{ tip }}</p>

    <div class="tool-card">
      <h3 class="tool-card__title">选项（每行一个，也可用逗号分隔）</h3>
      <van-field v-model="text" type="textarea" rows="3" autosize :disabled="spinning" />
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 转盘卡片：居中排布 */
.wheel-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-3;

  &__result {
    min-height: 30px;
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    text-align: center;
    color: var(--c-primary);
  }
}

/* 转盘舞台：用 padding-top 撑出正方形，兼容不支持 aspect-ratio 的旧 WebView */
.stage {
  position: relative;
  width: min(72vw, 300px);
  margin-top: $space-3;

  &::before {
    content: '';
    display: block;
    padding-top: 100%;
  }
}

/* 顶部指针 */
.pointer {
  position: absolute;
  top: -10px;
  left: 50%;
  z-index: 1;
  width: 0;
  height: 0;
  margin-left: -12px;
  border-left: 12px solid transparent;
  border-right: 12px solid transparent;
  border-top: 22px solid var(--c-text);
}

/* 转盘本体 */
.wheel {
  position: absolute;
  inset: 0;
  border: 4px solid var(--c-surface);
  border-radius: 50%;
  box-shadow: 0 0 0 1px var(--c-border);
  transition: transform 4s cubic-bezier(0.17, 0.67, 0.12, 0.99);
}

@media (prefers-reduced-motion: reduce) {
  .wheel {
    transition: none;
  }
}

/* 扇区中心线容器 */
.spoke {
  position: absolute;
  inset: 0;
}

/* 标签沿半径排布：中心落在半径约一半处，字从圆心向外读；下半圈翻 180 度避免倒字 */
.label {
  position: absolute;
  top: 25%;
  left: 50%;
  width: 36%;
  height: 24px;
  margin: -12px 0 0 -18%;
  overflow: hidden;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  line-height: 24px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 2px rgb(0 0 0 / 45%);
  transform: rotate(-90deg);

  &--flip {
    transform: rotate(90deg);
  }
}
</style>
