<script setup lang="ts">
// 时间屏幕：大字时钟（数字/翻页），可显示秒、日期、农历，全屏时尽量保持常亮
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { showToast } from 'vant'
import CellPicker from '@/shared/CellPicker.vue'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { burnInOffset, clockParts, formatDateLine, lunarText, startSecondTicker, type LunarLib } from './logic'
import { createAppAwake } from './awake'

/** 本工具的持久缓存 */
const store = createToolStorage('clock-screen')
/** 判断是否布尔值，供开关缓存校验 */
const isBool = (v: unknown): boolean => typeof v === 'boolean'
/** 一分钟的毫秒数 */
const MS_PER_MINUTE = 60000
/** 不支持常亮时的提示 */
const TIP_NO_WAKE = '常亮没打开，请在系统设置里调长息屏时间'
/** 农历库加载失败提示 */
const TIP_LUNAR_FAIL = '农历数据加载失败了'

/** 时钟样式类型：数字或翻页 */
type ClockStyle = 'digital' | 'flip'
/** 样式选项 */
const STYLE_OPTIONS = [
  { value: 'digital', label: '数字' },
  { value: 'flip', label: '翻页' },
]

/** 显示样式：数字或翻页 */
const style = usePersistedRef<ClockStyle>(store, 'style', 'digital', (v) => STYLE_OPTIONS.some((o) => o.value === v))
/** 是否显示秒 */
const showSeconds = usePersistedRef(store, 'showSeconds', true, isBool)
/** 是否显示日期与星期 */
const showDate = usePersistedRef(store, 'showDate', true, isBool)
/** 是否 24 小时制 */
const hour24 = usePersistedRef(store, 'hour24', true, isBool)
/** 是否显示农历 */
const showLunar = usePersistedRef(store, 'showLunar', false, isBool)
/** 是否全屏展示 */
const full = ref(false)
/** 当前时间 */
const now = ref(new Date())
/** 动态加载的农历库，未打开农历开关前一直为空 */
const lunarLib = shallowRef<LunarLib | null>(null)
/** 常亮控制器 */
const wake = createAppAwake()
/** 整秒定时器的停止函数 */
let stopTicker: (() => void) | undefined

/** 拆好的时分秒 */
const parts = computed(() => clockParts(now.value, hour24.value))
/** 时分（秒）的字符序列，供数字/翻页渲染 */
const groups = computed(() => {
  const g = [parts.value.hh, parts.value.mm]
  if (showSeconds.value) g.push(parts.value.ss)
  return g
})
/** 日期行 */
const dateLine = computed(() => formatDateLine(now.value))
/** 农历行；库未就绪时为空 */
const lunarLine = computed(() => (showLunar.value && lunarLib.value ? lunarText(lunarLib.value, now.value) : ''))
/** 防烧屏偏移，仅全屏时生效 */
const burnStyle = computed(() => {
  if (!full.value) return undefined
  const o = burnInOffset(Math.floor(now.value.getTime() / MS_PER_MINUTE))
  return { transform: `translate(${o.x}px, ${o.y}px)` }
})

/** 启动整秒定时器（已启动则忽略） */
function startTick(): void {
  if (!stopTicker) stopTicker = startSecondTicker((d) => (now.value = d))
}

/** 停止整秒定时器 */
function stopTick(): void {
  stopTicker?.()
  stopTicker = undefined
}

/** 页面不可见时暂停刷新，回来再恢复 */
function onVisibility(): void {
  if (document.visibilityState === 'visible') startTick()
  else stopTick()
}

/** 进入全屏：申请常亮，失败只提示不报错 */
async function enterFull(): Promise<void> {
  full.value = true
  if (!(await wake.acquire())) showToast(TIP_NO_WAKE)
}

/** 退出全屏并释放常亮 */
async function exitFull(): Promise<void> {
  full.value = false
  await wake.release()
}

/** 打开农历开关后才动态加载 tyme4ts，避免拖慢首屏；缓存里已开启时进页即加载 */
watch(
  showLunar,
  async (on) => {
    if (!on || lunarLib.value) return
    try {
      lunarLib.value = (await import('tyme4ts')) as unknown as LunarLib
    } catch {
      showLunar.value = false
      showToast(TIP_LUNAR_FAIL)
    }
  },
  { immediate: true },
)

onMounted(() => {
  startTick()
  document.addEventListener('visibilitychange', onVisibility)
})
onUnmounted(() => {
  stopTick()
  document.removeEventListener('visibilitychange', onVisibility)
  void wake.release()
})
</script>

<template>
  <div class="tool-page">
    <div class="clock-wrap" :class="{ 'clock-wrap--full': full }">
      <div class="clock" :class="[`clock--${style}`, { 'clock--sec': showSeconds }]" :style="burnStyle">
        <div class="clock__time" aria-live="off">
          <template v-for="(g, gi) in groups" :key="gi">
            <span v-if="gi > 0" class="clock__colon">:</span>
            <span class="clock__group">
              <span v-for="(ch, ci) in g" :key="`${gi}${ci}${ch}`" class="clock__digit">{{ ch }}</span>
            </span>
          </template>
          <span v-if="parts.period" class="clock__period">{{ parts.period }}</span>
        </div>
        <div v-if="showDate" class="clock__date">{{ dateLine }}</div>
        <div v-if="lunarLine" class="clock__date">{{ lunarLine }}</div>
      </div>
      <van-button v-if="full" class="clock__close" size="small" round plain @click="exitFull">退出</van-button>
    </div>

    <tool-group title="样式">
      <cell-picker :model-value="style" title="时钟样式" :options="STYLE_OPTIONS" @update:model-value="style = $event as ClockStyle" />
      <van-cell-group :border="false">
        <van-cell title="显示秒" center><template #value><van-switch v-model="showSeconds" size="22" /></template></van-cell>
        <van-cell title="显示日期与星期" center><template #value><van-switch v-model="showDate" size="22" /></template></van-cell>
        <van-cell title="24 小时制" center><template #value><van-switch v-model="hour24" size="22" /></template></van-cell>
        <van-cell title="显示农历" center><template #value><van-switch v-model="showLunar" size="22" /></template></van-cell>
      </van-cell-group>
    </tool-group>

    <p class="tool-hint">全屏时会尝试保持屏幕常亮，并让文字每分钟轻微位移，减轻烧屏。横屏效果更好，请先在系统里打开自动旋转。</p>

    <!-- 底部动作栏：主按钮全屏显示（全屏层 z-index 3000，会盖住这条栏） -->
    <bottom-actions main main-text="全屏显示" @main="enterFull" />
  </div>
</template>

<style lang="scss" scoped>
/* 时钟外框：普通态是一张卡片，全屏态铺满视口 */
.clock-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: $space-4;
  background: var(--c-surface);
  border-radius: var(--tool-card-radius);

  &--full {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 3000;
    padding: 0;
    border-radius: 0;
    background: #000;
    color: #f2f2f2;
  }
}

/* 时钟主体 */
.clock {
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: inherit;
  transition: transform 1s;

  /* 时间行 */
  &__time {
    display: flex;
    align-items: baseline;
    justify-content: center;
    font-size: 15vw;
    font-weight: 600;
    line-height: 1.15;
    color: var(--c-text);
  }

  /* 日期行 */
  &__date {
    margin-top: $space-2;
    font-size: 4.5vw;
    color: var(--c-text-muted);
  }

  /* 上午/下午 */
  &__period {
    margin-left: $space-2;
    font-size: 0.3em;
  }

  /* 冒号略上提 */
  &__colon {
    margin: 0 0.04em;
    padding-bottom: 0.08em;
  }

  /* 一组两位数 */
  &__group {
    display: inline-flex;
    gap: 0.04em;
  }

  /* 单个数字 */
  &__digit {
    display: inline-block;
    min-width: 0.62em;
    text-align: center;
  }

  /* 带秒时字更小以便放下 */
  &--sec .clock__time {
    font-size: 11vw;
  }

  /* 翻页样式：每个数字一块卡片，值变化时重新挂载并播放翻入动画 */
  &--flip .clock__digit {
    padding: 0.04em 0.06em;
    border-radius: 0.12em;
    background: var(--c-surface-active);
    animation: flip-in 0.45s ease-out;
    transform-origin: 50% 50%;
  }
}

/* 全屏态：字号用视口短边约束，横屏不溢出 */
.clock-wrap--full {
  .clock__time {
    color: #f2f2f2;
    font-size: min(30vw, 55vh);
  }

  .clock--sec .clock__time {
    font-size: min(17vw, 42vh);
  }

  .clock__date {
    color: #9a9a9a;
    font-size: min(5vw, 8vh);
  }

  .clock--flip .clock__digit {
    background: #1e1e1e;
  }
}

/* 退出按钮 */
.clock__close {
  position: absolute;
  top: calc(12px + var(--safe-top));
  right: calc(12px + var(--safe-right));
  opacity: 0.6;
}

@keyframes flip-in {
  from {
    transform: rotateX(-90deg);
    opacity: 0.2;
  }

  to {
    transform: rotateX(0);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .clock--flip .clock__digit {
    animation: none;
  }

  .clock {
    transition: none;
  }
}
</style>
