<script setup lang="ts">
// 打字板（含原手持弹幕）：输入文字后全屏横屏展示，文字没超出屏幕就静止，超出就横向滚动
import BottomActions from '@/shared/BottomActions.vue'
import ColorPicker from '@/shared/ColorPicker.vue'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { showToast } from 'vant'
import ExitIcon from '~icons/cil/fullscreen-exit?width=1em&height=1em'
import { createLandscape } from '@/shared/landscape'
import { prefersReducedMotion } from '@/shared/motion'
import { createAppAwake } from '../clock-screen/awake'
import {
  type Align,
  BLINK_HZ_MAX,
  BLINK_HZ_MIN,
  blinkPeriod,
  cleanText,
  DEFAULT_TEXT,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  invertColor,
  loadRecent,
  overflows,
  PRESETS,
  pushRecent,
  saveRecent,
  scrollDuration,
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  TEXT_MAX,
  WEIGHTS,
} from './logic'

/** 不支持常亮时的提示 */
const TIP_NO_WAKE = '常亮没打开，请在系统设置里调长息屏时间'
/** 粗细名称 */
const WEIGHT_NAMES: Record<number, string> = { 400: '常规', 700: '加粗', 900: '特粗' }

/** 取本地存储，不可用时为 undefined */
function getStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/** 输入的文字 */
const text = ref(PRESETS[0].text)
/** 字色 */
const fg = ref(PRESETS[0].fg)
/** 背景色 */
const bg = ref(PRESETS[0].bg)
/** 字号（像素） */
const fontSize = ref(FONT_DEFAULT)
/** 滚动速度（像素/秒），只在文字超出屏幕时生效 */
const speed = ref(SPEED_DEFAULT)
/** 字重 */
const weight = ref<number>(700)
/** 静止时的对齐 */
const align = ref<Align>('center')
/** 是否闪烁 */
const blink = ref(false)
/** 闪烁频率 */
const hz = ref(1)
/** 闪烁时是否反色 */
const invert = ref(false)
/** 是否处于展示模式 */
const showing = ref(false)
/** 实际展示的文字（整理后的单行） */
const shown = ref(DEFAULT_TEXT)
/** 最近用过的文案 */
const recent = ref<string[]>(loadRecent(getStorage()))
/** 单行文字宽度（像素） */
const textW = ref(0)
/** 屏幕宽度（像素） */
const viewW = ref(360)
/** 是否尊重减少动态效果（展示前取值）：为 true 时不滚动，超出就换行静止 */
const still = ref(false)
/** 用于测量的隐藏节点 */
const probeRef = ref<HTMLElement>()
/** 常亮控制器（原生优先，网页兜底） */
const wake = createAppAwake()
/** 横屏控制器：展示时切原生横屏沉浸 */
const land = createLandscape()

/** 文字是否超出屏幕（决定滚动还是静止） */
const over = computed(() => overflows(textW.value, viewW.value))
/** 是否滚动：超出且没开减少动态效果 */
const scrolling = computed(() => over.value && !still.value)
/** 一圈滚动秒数，至少 1 秒防止异常值 */
const duration = computed(() => Math.max(1, scrollDuration(textW.value, viewW.value, speed.value)))
/** 展示层样式与 CSS 变量 */
const stageStyle = computed(() => ({
  '--fg': fg.value,
  '--bg': bg.value,
  '--fg2': invert.value ? invertColor(fg.value) : fg.value,
  '--bg2': invert.value ? invertColor(bg.value) : bg.value,
  '--fs': `${fontSize.value}px`,
  '--fw': weight.value,
  '--ta': align.value,
  '--from': `${viewW.value}px`,
  '--to': `${-textW.value}px`,
  '--dur': `${duration.value}s`,
  '--period': `${blinkPeriod(hz.value)}s`,
}))
/** 闪烁动画名：反色闪换底色，普通闪只隐藏文字 */
const blinkClass = computed(() => (!blink.value ? '' : invert.value ? 'tb-stage--invert' : 'tb-stage--hide'))

/** 量单行文字宽度与屏幕宽度（用隐藏节点，字号字重与展示一致） */
async function measure(): Promise<void> {
  await nextTick()
  viewW.value = window.innerWidth
  const el = probeRef.value
  if (!el) return
  el.textContent = shown.value
  el.style.fontSize = `${fontSize.value}px`
  textW.value = el.offsetWidth
}

/** 进入展示：整理文案、记入最近、切横屏、申请常亮 */
async function show(): Promise<void> {
  shown.value = cleanText(text.value)
  text.value = shown.value
  recent.value = pushRecent(recent.value, shown.value)
  saveRecent(getStorage(), recent.value)
  still.value = prefersReducedMotion()
  showing.value = true
  void measure()
  const [awake] = await Promise.all([wake.acquire(), land.enter()])
  if (!awake) showToast(TIP_NO_WAKE)
}

/** 回到编辑：释放常亮并还原竖屏 */
async function edit(): Promise<void> {
  showing.value = false
  await Promise.all([wake.release(), land.leave()])
}

/** 套用预设 */
function applyPreset(i: number): void {
  const p = PRESETS[i]
  fg.value = p.fg
  bg.value = p.bg
  if (!text.value.trim()) text.value = p.text
}

watch([fontSize, weight, shown], () => {
  if (showing.value) void measure()
})

/** 窗口尺寸变化（含横竖屏）时重新量 */
function onResize(): void {
  if (showing.value) void measure()
}

onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  void wake.release()
  void land.leave()
})
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <van-field v-model="text" label="文字" placeholder="想让别人看到的话" :maxlength="TEXT_MAX" show-word-limit clearable />
      <div v-if="recent.length" class="tb-recent">
        <span class="tb-recent__label">最近：</span>
        <van-tag v-for="r in recent" :key="r" plain type="primary" size="large" class="tb-recent__tag" @click="text = r">{{ r }}</van-tag>
      </div>
    </tool-group>

    <tool-group title="配色预设">
      <div class="tb-presets">
        <van-button v-for="(p, i) in PRESETS" :key="p.name" size="small" round :style="{ background: p.bg, color: p.fg, borderColor: p.fg }" @click="applyPreset(i)">{{ p.name }}</van-button>
      </div>
      <div class="tb-colors">
        <label>字色 <color-picker v-model="fg" label="字色" /></label>
        <label>背景 <color-picker v-model="bg" label="背景色" /></label>
      </div>
    </tool-group>

    <tool-group :title="`字号 ${fontSize}`">
      <van-slider v-model="fontSize" :min="FONT_MIN" :max="FONT_MAX" :step="4" />
      <h3 class="tool-group__title tb-gap">滚动速度 {{ speed }}（文字超出屏幕时才滚动）</h3>
      <van-slider v-model="speed" :min="SPEED_MIN" :max="SPEED_MAX" :step="10" />
      <h3 class="tool-group__title tb-gap">粗细</h3>
      <van-radio-group v-model="weight" direction="horizontal">
        <van-radio v-for="w in WEIGHTS" :key="w" :name="w">{{ WEIGHT_NAMES[w] }}</van-radio>
      </van-radio-group>
      <h3 class="tool-group__title tb-gap">对齐（没超出屏幕时）</h3>
      <van-radio-group v-model="align" direction="horizontal">
        <van-radio name="left">居左</van-radio>
        <van-radio name="center">居中</van-radio>
        <van-radio name="right">居右</van-radio>
      </van-radio-group>
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <van-cell title="闪烁" center><template #value><van-switch v-model="blink" size="22" /></template></van-cell>
        <template v-if="blink">
          <van-cell title="闪烁时反色" center><template #value><van-switch v-model="invert" size="22" /></template></van-cell>
        </template>
      </van-cell-group>
      <template v-if="blink">
        <h3 class="tool-group__title tb-gap">频率 {{ hz }} Hz</h3>
        <van-slider v-model="hz" :min="BLINK_HZ_MIN" :max="BLINK_HZ_MAX" :step="0.5" />
      </template>
    </tool-group>

    <p class="tool-hint">展示时自动横屏：文字没超出屏幕就静止，超出就横向滚动。点右下角的退出按钮回到编辑（点屏幕不会退出，防误触），并会保持屏幕常亮。闪烁有光敏风险，请谨慎使用。</p>

    <!-- 底部动作栏：主按钮全屏展示（展示层 z-index 更高，会盖住这条栏） -->
    <bottom-actions main main-text="全屏展示" @main="show" />

    <div ref="probeRef" class="tb-probe" :style="{ fontWeight: weight }" aria-hidden="true" />

    <div v-if="showing" class="tb-stage" :class="blinkClass" :style="stageStyle">
      <div class="tb-stage__row">
        <span
          class="tb-stage__text"
          :class="{ 'tb-stage__text--scroll': scrolling, 'tb-stage__text--wrap': over && still }"
        >{{ shown }}</span>
      </div>
      <button type="button" class="tb-stage__exit" aria-label="退出全屏" @click="edit"><exit-icon /></button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tb-gap {
  margin-top: $space-4;
}

/* 最近文案区 */
.tb-recent {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  align-items: center;
  margin-top: $space-2;

  &__label {
    font-size: 13px;
    color: var(--c-text-muted);
  }

  &__tag {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

/* 预设按钮行 */
.tb-presets {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

/* 取色行 */
.tb-colors {
  display: flex;
  gap: $space-4;
  margin-top: $space-3;
  font-size: 14px;
}

/* 测量用节点：不可见、不占位，单行不换行，字重与展示一致（字号在脚本里设） */
.tb-probe {
  position: fixed;
  top: 0;
  left: -99999px;
  width: max-content;
  visibility: hidden;
  line-height: 1.25;
  white-space: nowrap;
}

/* 全屏展示层 */
.tb-stage {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 3000;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--bg);
  color: var(--fg);
  user-select: none;

  /* 文字行：垂直居中，左右留白 */
  &__row {
    display: flex;
    align-items: center;
    height: 100%;
    padding: 0 16px; /* 与 logic.ts 的 STAGE_PAD 一致 */
  }

  /* 右下角退出按钮：半透明深底白图标，任何底色上都看得清；闪烁时不参与动画 */
  &__exit {
    position: absolute;
    right: max(16px, var(--safe-right));
    bottom: max(16px, var(--safe-bottom));
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    font-size: 24px;
    color: #fff;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.6);
    border-radius: 50%;
  }

  /* 文字：没超出时按对齐静止；单行不换行 */
  &__text {
    flex: 1;
    font-size: var(--fs);
    font-weight: var(--fw);
    line-height: 1.25;
    text-align: var(--ta);
    white-space: nowrap;

    /* 超出屏幕：从右滚到左，只用 transform 动画，走合成层 */
    &--scroll {
      flex: none;
      will-change: transform;
      animation: tb-scroll var(--dur) linear infinite;
    }

    /* 超出但开了减少动态效果：不滚动，允许换行 */
    &--wrap {
      white-space: normal;
      word-break: break-all;
    }
  }

  &--hide {
    animation: tb-hide var(--period) steps(1) infinite;
  }

  &--invert {
    animation: tb-invert var(--period) steps(1) infinite;
  }
}

/* 滚动：从屏幕右侧外滚到左侧外 */
@keyframes tb-scroll {
  from {
    transform: translateX(var(--from));
  }

  to {
    transform: translateX(var(--to));
  }
}

/* 普通闪：后半周期字色变成底色 */
@keyframes tb-hide {
  50% {
    color: var(--bg);
  }
}

/* 反色闪：后半周期底色字色对调 */
@keyframes tb-invert {
  50% {
    color: var(--fg2);
    background: var(--bg2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tb-stage--hide,
  .tb-stage--invert {
    animation-duration: 2s;
  }
}
</style>
