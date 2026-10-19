<script setup lang="ts">
// 屏幕测试：纯色/灰阶全屏检查坏点，触摸测试检查盲区
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onUnmounted, ref } from 'vue'
import { showToast } from 'vant'
import { createAppAwake } from '../clock-screen/awake'
import { cellIndex, coverage, nextScreen, SCREENS, TOUCH_COLS, TOUCH_ROWS } from './logic'

/** 常亮失败提示 */
const TIP_NO_WAKE = '常亮没打开，测试时请留意息屏时间'
/** 总格数 */
const TOTAL = TOUCH_COLS * TOUCH_ROWS

/** 全屏模式：无 / 纯色 / 触摸 */
const mode = ref<'none' | 'color' | 'touch'>('none')
/** 当前纯色画面下标 */
const idx = ref(0)
/** 已点亮格子 */
const lit = ref<Set<number>>(new Set())
/** 常亮控制器 */
const wake = createAppAwake()

/** 当前画面 */
const screen = computed(() => SCREENS[idx.value])
/** 覆盖率 */
const percent = computed(() => coverage(lit.value.size, TOTAL))
/** 格子序号列表 */
const cells = Array.from({ length: TOTAL }, (_, i) => i)

/** 进入全屏测试 */
async function enter(m: 'color' | 'touch'): Promise<void> {
  mode.value = m
  idx.value = 0
  lit.value = new Set()
  if (!(await wake.acquire())) showToast(TIP_NO_WAKE)
}

/** 退出全屏 */
async function exit(): Promise<void> {
  mode.value = 'none'
  await wake.release()
}

/** 点击切换到下一个画面 */
function onTap(): void {
  idx.value = nextScreen(idx.value)
}

/** 手指移动：点亮经过的格子 */
function onTouch(e: TouchEvent | PointerEvent): void {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const pts = 'touches' in e ? Array.from(e.touches) : [e]
  const next = new Set(lit.value)
  for (const p of pts) {
    const i = cellIndex(p.clientX - r.left, p.clientY - r.top, r.width, r.height)
    if (i >= 0) next.add(i)
  }
  if (next.size !== lit.value.size) lit.value = next
}

/** 清空点亮 */
function resetTouch(): void {
  lit.value = new Set()
}

onUnmounted(() => void wake.release())
</script>

<template>
  <div class="tool-page">
    <tool-group title="坏点 / 亮点检查">
      <p class="tool-hint">依次全屏显示红、绿、蓝、白、黑和灰阶渐变，点一下切换。盯着屏幕找不随画面变化的亮点或暗点。</p>
      <van-button block type="primary" @click="enter('color')">开始纯色测试</van-button>
    </tool-group>
    <tool-group title="触摸测试">
      <p class="tool-hint">手指划过的格子会被点亮，没法点亮的区域就是触摸盲区。</p>
      <van-button block type="primary" plain @click="enter('touch')">开始触摸测试</van-button>
    </tool-group>

    <div v-if="mode === 'color'" class="st-full" :style="{ background: screen.background }" @click="onTap">
      <span class="st-tip" :class="{ 'st-tip--light': screen.light }">{{ screen.name }}（{{ idx + 1 }}/{{ SCREENS.length }}），点屏幕切换</span>
      <van-button class="st-close" size="small" round plain @click.stop="exit">退出</van-button>
    </div>

    <div v-if="mode === 'touch'" class="st-full st-full--touch">
      <div class="st-grid" @touchstart.prevent="onTouch" @touchmove.prevent="onTouch" @pointermove="onTouch">
        <i v-for="c in cells" :key="c" class="st-cell" :class="{ 'st-cell--on': lit.has(c) }" />
      </div>
      <span class="st-tip st-tip--light st-tip--top">已点亮 {{ percent }}%</span>
      <div class="st-bar">
        <van-button size="small" round plain @click.stop="resetTouch">清空</van-button>
        <van-button size="small" round plain @click.stop="exit">退出</van-button>
      </div>
    </div>

    <bottom-actions main main-text="开始纯色测试" @main="enter('color')" />
  </div>
</template>

<style lang="scss" scoped>
/* 全屏层，盖住底部栏 */
.st-full {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  user-select: none;
  -webkit-user-select: none;

  &--touch {
    background: #111;
  }
}

/* 提示文字（颜色是画面色，不随主题变） */
.st-tip {
  margin-bottom: calc(24px + var(--safe-bottom));
  padding: 2px 10px;
  border-radius: 10px;
  color: #000;
  font-size: 14px;
  background: rgb(255 255 255 / 0.45);

  &--light {
    color: #fff;
    background: rgb(0 0 0 / 0.4);
  }

  &--top {
    position: absolute;
    top: calc(14px + var(--safe-top));
    left: 12px;
    margin: 0;
  }
}

/* 退出按钮 */
.st-close {
  position: absolute;
  top: calc(12px + var(--safe-top));
  right: calc(12px + var(--safe-right));
  opacity: 0.7;
}

/* 触摸格子区 */
.st-grid {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  grid-template-rows: repeat(14, 1fr);
  touch-action: none;
}

/* 单格 */
.st-cell {
  border: 1px solid #2a2a2a;

  &--on {
    background: #07c160;
  }
}

/* 触摸测试操作条 */
.st-bar {
  position: absolute;
  top: calc(12px + var(--safe-top));
  right: calc(12px + var(--safe-right));
  display: flex;
  gap: 8px;
}
</style>
