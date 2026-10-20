<script setup lang="ts">
// 抛硬币：点一下抛一次，可连抛并统计；先定结果再播动画
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import CellPicker from '@/shared/CellPicker.vue'
import { prefersReducedMotion } from '@/shared/motion'
import { countSides, flipCoin, flipCoins, loadFlag, MAX_FLIPS, saveFlag, SIDE_LABEL, SOUND_KEY, VIBRATE_KEY, VIBRATE_LAND, VIBRATE_START, type CoinSide } from './logic'
import { createSoundPlayer, tryVibrate } from './feedback'

/** 动画时长（毫秒），需与样式里的 --flip-ms 一致 */
const ANIM_MS = 900
/** 一次抛掷至少翻的整圈数 */
const SPIN_TURNS = 5
/** 一圈的角度 */
const FULL_TURN = 360
/** 翻到另一面所需的半圈角度 */
const HALF_TURN = 180
/** 硬币厚度（像素），两面分居 ±厚度/2 处 */
const COIN_THICKNESS = 10
/** 边缘切片数量，叠起来形成可见的侧面厚度 */
const EDGE_SLICES = 8
/** 每片边缘的 Z 偏移（像素），均匀铺满整个厚度 */
const EDGE_OFFSETS = Array.from(
  { length: EDGE_SLICES },
  (_, i) => (i / (EDGE_SLICES - 1) - 0.5) * COIN_THICKNESS,
)
/** 连抛次数可选项 */
const BATCH_OPTIONS = [1, 3, 5, 10, MAX_FLIPS].map((n) => ({ value: n, label: `${n} 次` }))

/** 当前显示的面 */
const side = ref<CoinSide>('heads')
/** 是否正在翻转 */
const flipping = ref(false)
/** 硬币累计旋转角度；恒保持"模 360 为 0 是正面，为 180 是反面" */
const angle = ref(0)
/** 是否带过渡动画（减弱动效时直接落位） */
const animated = ref(true)
/** 连抛次数 */
const batch = ref(1)
/** 本轮历史结果（最新在前） */
const history = ref<CoinSide[]>([])
/** 定时器句柄 */
let timer: ReturnType<typeof setTimeout> | undefined
/** 取 localStorage，不可用时为 undefined */
function getStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}
/** 震动反馈开关，默认开 */
const vibrateOn = ref(loadFlag(getStorage(), VIBRATE_KEY, true))
/** 音效开关，默认关 */
const soundOn = ref(loadFlag(getStorage(), SOUND_KEY, false))
/** 合成音播放器 */
const sound = createSoundPlayer()

/** 开关变化时落盘 */
watch(vibrateOn, (v) => saveFlag(getStorage(), VIBRATE_KEY, v))
watch(soundOn, (v) => saveFlag(getStorage(), SOUND_KEY, v))

/** 触发某个时刻的反馈（震动与音效各自看开关） */
function feedback(kind: 'start' | 'land'): void {
  if (vibrateOn.value) void tryVibrate(kind === 'start' ? VIBRATE_START : VIBRATE_LAND)
  if (soundOn.value) sound.play(kind)
}

/** 历史统计 */
const stats = computed(() => countSides(history.value))
/** 展示用的最近若干条历史 */
const recent = computed(() => history.value.slice(0, 30))

/** 抛硬币：连抛时每次结果都入历史，硬币停在最后一次的结果上 */
function toss(): void {
  if (flipping.value) return
  // AudioContext 必须在用户手势里创建 / resume
  if (soundOn.value) sound.unlock()
  const n = Math.min(Math.max(Math.floor(batch.value) || 1, 1), MAX_FLIPS)
  const results = n === 1 ? [flipCoin()] : flipCoins(n)
  const last = results[results.length - 1]
  const finish = () => {
    side.value = last
    history.value = results.slice().reverse().concat(history.value).slice(0, 500)
    flipping.value = false
    feedback('land')
  }
  /** 结果与当前朝向不同，要多翻半圈才能落到对应面 */
  const extra = last === side.value ? 0 : HALF_TURN
  if (prefersReducedMotion()) {
    animated.value = false
    angle.value += extra
    return finish()
  }
  animated.value = true
  flipping.value = true
  feedback('start')
  angle.value += SPIN_TURNS * FULL_TURN + extra
  timer = setTimeout(finish, ANIM_MS)
}

/** 清空历史 */
function reset(): void {
  history.value = []
}

onBeforeUnmount(() => {
  clearTimeout(timer)
  sound.dispose()
})
</script>

<template>
  <div class="tool-page">
    <tool-group class="coin-stage">
      <div class="coin-scene" :class="{ 'coin-scene--fly': flipping }">
        <div class="coin-shadow" aria-hidden="true"></div>
        <div class="coin-wrap">
          <div
            class="coin"
            :class="{ 'coin--still': !animated }"
            :style="{ transform: `rotateX(${angle}deg)` }"
            role="button"
            tabindex="0"
            aria-label="抛硬币"
            @click="toss"
            @keydown.enter.prevent="toss"
            @keydown.space.prevent="toss"
          >
            <span
              v-for="z in EDGE_OFFSETS"
              :key="z"
              class="coin__edge"
              :style="{ transform: `translateZ(${z}px)` }"
            ></span>
            <span class="coin__face coin__face--heads" :style="{ transform: `translateZ(${COIN_THICKNESS / 2}px)` }">{{ SIDE_LABEL.heads }}</span>
            <span class="coin__face coin__face--tails" :style="{ transform: `rotateX(180deg) translateZ(${COIN_THICKNESS / 2}px)` }">{{ SIDE_LABEL.tails }}</span>
          </div>
        </div>
      </div>
      <p class="coin-stage__text" aria-live="polite">{{ flipping ? '抛起来了…' : history.length ? SIDE_LABEL[side] : '点硬币开抛' }}</p>
    </tool-group>

    <tool-group>
      <cell-picker :model-value="batch" title="连抛次数" :options="BATCH_OPTIONS" :disabled="flipping" @update:model-value="batch = $event as number" />
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <van-cell title="震动反馈" center>
          <template #right-icon><van-switch v-model="vibrateOn" size="20" /></template>
        </van-cell>
        <van-cell title="音效" center>
          <template #right-icon><van-switch v-model="soundOn" size="20" /></template>
        </van-cell>
      </van-cell-group>
    </tool-group>

    <tool-group v-if="history.length" :title="`共 ${history.length} 次：正面 ${stats.heads}，反面 ${stats.tails}`">
      <p class="trail">
        <span v-for="(h, i) in recent" :key="i" class="dot" :class="`dot--${h}`">{{ h === 'heads' ? '正' : '反' }}</span>
      </p>
      <van-button size="small" plain block @click="reset">清空记录</van-button>
    </tool-group>

    <!-- 底部动作栏：主按钮抛硬币（点硬币也行） -->
    <bottom-actions main main-text="抛！" :disabled="{ main: flipping }" @main="toss" />
  </div>
</template>

<style lang="scss" scoped>
/* 硬币舞台：居中排布；顶部留白给抛起的弧线，避免被顶栏盖住 */
.coin-stage {
  padding-top: 100px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-3;

  &__text {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--c-text);
  }
}

/* 场景：硬币与地面阴影同处一个定位容器，阴影留在地面，硬币抛起 */
.coin-scene {
  position: relative;
  width: 168px;
  height: 196px;
}

/* 地面阴影：硬币越高，阴影越小越淡（与高度成反比） */
.coin-shadow {
  position: absolute;
  bottom: 4px;
  left: 50%;
  width: 150px;
  height: 22px;
  margin-left: -75px;
  border-radius: 50%;
  background: radial-gradient(ellipse at center, rgba(0, 0, 0, 0.42) 0%, rgba(0, 0, 0, 0.18) 55%, rgba(0, 0, 0, 0) 75%);
}

/* 硬币容器：透视；整体沿弧线抛起，越高越小（景深） */
.coin-wrap {
  position: absolute;
  top: 0;
  left: 0;
  width: 168px;
  height: 168px;
  perspective: 700px;
  -webkit-perspective: 700px;
}

.coin-scene--fly .coin-wrap {
  animation: toss-arc 0.9s linear;
}

.coin-scene--fly .coin-shadow {
  animation: shadow-pulse 0.9s linear;
}

/* 硬币本体：保留 3D，两面各自背面隐藏；金属色属于内容色，不随主题变 */
.coin {
  position: relative;
  width: 100%;
  height: 100%;
  cursor: pointer;
  transform-style: preserve-3d;
  -webkit-transform-style: preserve-3d;
  transition: transform 0.9s cubic-bezier(0.2, 0.7, 0.25, 1);
  -webkit-tap-highlight-color: transparent;

  &--still {
    transition: none;
  }

  /* 边缘切片：一圈金属色圆盘叠成侧面厚度 */
  &__edge {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    border-radius: 50%;
    background: linear-gradient(180deg, #e8b83a, #a8780f);
  }

  &__face {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    border: 6px solid;
    border-radius: 50%;
    font-size: 40px;
    font-weight: 700;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    /* 内圈压痕与高光，让面更像压铸的金属 */
    box-shadow: inset 0 0 0 3px rgba(255, 255, 255, 0.28), inset 0 -8px 14px rgba(0, 0, 0, 0.2);

    &--heads {
      border-color: #c9971c;
      background: radial-gradient(circle at 35% 30%, #fde68a, #e0a526);
      color: #6b4a00;
    }

    &--tails {
      border-color: #6b7280;
      background: radial-gradient(circle at 35% 30%, #e5e7eb, #9ca3af);
      color: #374151;
    }
  }
}

/* 抛掷弧线：上升减速、下落加速（重力）；越高越小、越虚（景深） */
@keyframes toss-arc {
  0% {
    transform: translateY(0) scale(1);
    filter: blur(0);
    animation-timing-function: cubic-bezier(0.15, 0.65, 0.3, 1);
  }
  50% {
    transform: translateY(-96px) scale(0.78);
    filter: blur(0.6px);
    animation-timing-function: cubic-bezier(0.7, 0, 0.85, 0.35);
  }
  100% {
    transform: translateY(0) scale(1);
    filter: blur(0);
  }
}

/* 阴影与高度成反比：最高处最小最淡 */
@keyframes shadow-pulse {
  0% {
    transform: scale(1);
    opacity: 1;
    animation-timing-function: cubic-bezier(0.15, 0.65, 0.3, 1);
  }
  50% {
    transform: scale(0.55);
    opacity: 0.45;
    animation-timing-function: cubic-bezier(0.7, 0, 0.85, 0.35);
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .coin-scene--fly .coin-wrap,
  .coin-scene--fly .coin-shadow {
    animation: none;
  }

  .coin {
    transition: none;
  }
}

/* 历史小圆点 */
.trail {
  display: flex;
  flex-wrap: wrap;
  gap: $space-1;
  margin: 0 0 $space-3;
}

.dot {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: 12px;
  line-height: 24px;
  text-align: center;
  color: #fff;
  background: #c9971c;

  &--tails {
    background: #6b7280;
  }
}
</style>
