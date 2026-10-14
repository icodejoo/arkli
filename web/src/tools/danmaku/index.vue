<script setup lang="ts">
// 手持弹幕：输入文字后全屏横向滚动（LED 屏效果），点屏幕呼出/收起控制面板
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { showToast } from 'vant'
import { prefersReducedMotion } from '@/shared/motion'
import { createAppAwake } from '../clock-screen/awake'
import {
  BG_COLORS,
  BLINK_SEC,
  clampNum,
  cleanText,
  DEFAULT_TEXT,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  loadRecent,
  pushRecent,
  saveRecent,
  scrollDuration,
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  TEXT_COLORS,
  TEXT_MAX,
} from './logic'

/** 不支持常亮时的提示 */
const TIP_NO_WAKE = '常亮没打开，请在系统设置里调长息屏时间'

/** 取本地存储，不可用时为 undefined */
function getStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/** 输入的文案 */
const input = ref(DEFAULT_TEXT)
/** 字号（像素） */
const fontSize = ref(FONT_DEFAULT)
/** 速度（像素/秒） */
const speed = ref(SPEED_DEFAULT)
/** 文字颜色 */
const fg = ref<string>(TEXT_COLORS[0][0])
/** 背景颜色 */
const bg = ref<string>(BG_COLORS[0][0])
/** 是否闪烁 */
const blink = ref(false)
/** 是否正在全屏播放 */
const playing = ref(false)
/** 播放时控制面板是否展开 */
const panel = ref(true)
/** 最近用过的文案 */
const recent = ref<string[]>(loadRecent(getStorage()))
/** 实际播放的文案 */
const shown = ref(DEFAULT_TEXT)
/** 文字宽度（像素） */
const textW = ref(0)
/** 屏幕宽度（像素） */
const viewW = ref(360)
/** 是否尊重减少动态效果（播放前取值） */
const still = ref(false)
/** 滚动文字节点 */
const textRef = ref<HTMLElement>()
/** 常亮控制器 */
const wake = createAppAwake()

/** 一圈滚动秒数，至少 1 秒防止异常值 */
const duration = computed(() => Math.max(1, scrollDuration(textW.value, viewW.value, speed.value)))
/** 全屏层的 CSS 变量与颜色 */
const stageStyle = computed(() => ({
  background: bg.value,
  color: fg.value,
  '--fs': `${fontSize.value}px`,
  '--from': `${viewW.value}px`,
  '--to': `${-textW.value}px`,
  '--dur': `${duration.value}s`,
  '--blink': `${BLINK_SEC}s`,
}))

/** 量文字与屏幕宽度 */
async function measure(): Promise<void> {
  await nextTick()
  viewW.value = window.innerWidth
  textW.value = textRef.value?.offsetWidth ?? 0
}

/** 开始播放：整理文案、记入最近、申请常亮 */
async function start(): Promise<void> {
  shown.value = cleanText(input.value)
  input.value = shown.value
  recent.value = pushRecent(recent.value, shown.value)
  saveRecent(getStorage(), recent.value)
  still.value = prefersReducedMotion()
  panel.value = false
  playing.value = true
  void measure()
  if (!(await wake.acquire())) showToast(TIP_NO_WAKE)
}

/** 停止播放并释放常亮 */
async function stop(): Promise<void> {
  playing.value = false
  await wake.release()
}

/** 播放中改字号时，文字宽度会变，重新量一遍 */
watch([fontSize, shown], () => {
  if (playing.value) void measure()
})

/** 窗口尺寸变化（含横竖屏切换）时重新量 */
function onResize(): void {
  if (playing.value) void measure()
}

onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  void wake.release()
})
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-field v-model="input" label="文字" placeholder="想让别人看到的话" :maxlength="TEXT_MAX" clearable />
      <div v-if="recent.length" class="dm-recent">
        <span class="dm-recent__label">最近：</span>
        <van-tag v-for="r in recent" :key="r" plain type="primary" size="large" class="dm-recent__tag" @click="input = r">{{ r }}</van-tag>
      </div>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">字号 {{ fontSize }}</h3>
      <van-slider v-model="fontSize" :min="FONT_MIN" :max="FONT_MAX" :step="4" />
      <h3 class="tool-card__title dm-gap">速度 {{ speed }}</h3>
      <van-slider v-model="speed" :min="SPEED_MIN" :max="SPEED_MAX" :step="10" />
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">文字颜色</h3>
      <div class="dm-swatches">
        <button v-for="[c, n] in TEXT_COLORS" :key="c" type="button" class="dm-swatch" :class="{ 'dm-swatch--on': fg === c }" :style="{ background: c }" :aria-label="n" @click="fg = c" />
      </div>
      <h3 class="tool-card__title dm-gap">背景颜色</h3>
      <div class="dm-swatches">
        <button v-for="[c, n] in BG_COLORS" :key="c" type="button" class="dm-swatch" :class="{ 'dm-swatch--on': bg === c }" :style="{ background: c }" :aria-label="n" @click="bg = c" />
      </div>
      <van-cell-group :border="false" class="dm-gap">
        <van-cell title="闪烁" center><template #value><van-switch v-model="blink" size="22" /></template></van-cell>
      </van-cell-group>
    </div>

    <div class="dm-preview" :style="{ background: bg, color: fg }">
      <span class="dm-preview__text">{{ cleanText(input) }}</span>
    </div>

    <van-button type="primary" block round @click="start">开始滚动</van-button>
    <p class="tool-hint">横屏手持效果最好，请先打开系统自动旋转。播放时点一下屏幕可呼出控制面板。</p>

    <div v-if="playing" class="dm-stage" :style="stageStyle" @click="panel = !panel">
      <div class="dm-stage__row">
        <span ref="textRef" class="dm-stage__text" :class="{ 'dm-stage__text--still': still, 'dm-stage__text--blink': blink }">{{ shown }}</span>
      </div>
      <div v-if="panel" class="dm-panel" @click.stop>
        <h3 class="dm-panel__title">字号 {{ fontSize }}</h3>
        <van-slider v-model="fontSize" :min="FONT_MIN" :max="FONT_MAX" :step="4" />
        <h3 class="dm-panel__title">速度 {{ speed }}</h3>
        <van-slider v-model="speed" :min="SPEED_MIN" :max="SPEED_MAX" :step="10" />
        <div class="dm-panel__row">
          <van-switch v-model="blink" size="20" />
          <span>闪烁</span>
          <van-button size="small" round type="danger" @click="stop">退出</van-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* 最近文案区 */
.dm-recent {
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

/* 区块间距 */
.dm-gap {
  margin-top: $space-4;
}

/* 色块列表 */
.dm-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: $space-3;
}

/* 单个色块：选中时画外圈 */
.dm-swatch {
  width: 36px;
  height: 36px;
  padding: 0;
  border: 2px solid var(--c-border);
  border-radius: 50%;
  cursor: pointer;

  &--on {
    box-shadow:
      0 0 0 2px var(--c-surface),
      0 0 0 4px var(--c-primary);
  }
}

/* 静态预览条 */
.dm-preview {
  padding: $space-4;
  overflow: hidden;
  border-radius: var(--tool-card-radius);
  text-align: center;
  white-space: nowrap;

  &__text {
    font-size: 28px;
    font-weight: 700;
  }
}

/* 全屏播放层 */
.dm-stage {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 3000;
  overflow: hidden;
  user-select: none;

  /* 滚动容器：文字垂直居中 */
  &__row {
    display: flex;
    align-items: center;
    height: 100%;
  }

  /* 文字：只用 transform 动画，走合成层 */
  &__text {
    flex: none;
    font-size: var(--fs);
    font-weight: 800;
    line-height: 1.2;
    white-space: nowrap;
    will-change: transform;
    animation: dm-scroll var(--dur) linear infinite;

    &--blink {
      animation:
        dm-scroll var(--dur) linear infinite,
        dm-blink var(--blink) steps(1) infinite;
    }

    /* 减少动态效果：静态居中，允许换行 */
    &--still {
      width: 100%;
      text-align: center;
      white-space: normal;
      word-break: break-all;
      animation: none;
      will-change: auto;
    }

    &--still.dm-stage__text--blink {
      animation: dm-blink 1.6s steps(1) infinite;
    }
  }
}

/* 底部控制面板 */
.dm-panel {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  padding: $space-4 $space-4 calc(#{$space-4} + env(safe-area-inset-bottom, 0px));
  background: rgba(0, 0, 0, 0.78);
  color: #fff;

  &__title {
    margin: $space-2 0 $space-3;
    font-size: 13px;
    font-weight: 500;
  }

  &__row {
    display: flex;
    gap: $space-2;
    align-items: center;
    justify-content: space-between;
    margin-top: $space-4;

    span {
      flex: 1;
      font-size: 14px;
    }
  }
}

@keyframes dm-scroll {
  from {
    transform: translateX(var(--from));
  }

  to {
    transform: translateX(var(--to));
  }
}

@keyframes dm-blink {
  50% {
    opacity: 0.15;
  }
}
</style>
