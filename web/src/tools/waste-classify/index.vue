<script setup lang="ts">
// 垃圾分类识别：选图 → 本地 CLIP 识物 → 顶部大字分类 + top-3 候选（点哪个就采纳哪个）。
// 模型的下载/删除/校验归 AI 中心与模型选择器，本页只读状态、只使用；页面只做装配，逻辑都在 logic.ts。
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import { useFloatBusy } from '@/shared/useFloatPause'
import { isNativeAvailable } from '@/native/bridge'
import { cameraItemToPicked, captureCamera, clearCamera, isAlbum, isCancelled } from '@/native/camera'
import { aiClassifyImage, type ImageClassifyResult } from '@/native/ai'
import { useModelsStore } from '@/stores/models'
import { EDIT_BASIC, pickImages, type PickedImage } from '@/shared/image-io'
import { resolveImagePath } from '@/tools/_ai/aiImage'
import {
  buildView,
  busyText,
  classifyFailure,
  defaultSelection,
  HEAT_TEXT,
  matchHints,
  MODEL_ID,
  NO_HOST_TEXT,
  shouldWarnHeat,
  stageOf,
  TOP_K,
} from './logic'

/** 忙碌文案刷新间隔（毫秒） */
const TICK_MS = 500

/** 模型未就绪时重新探测状态的间隔（毫秒）：用户在选择器里下完后页面自动解锁 */
const RECHECK_MS = 2000

/** 拍照产物所在缓存目录前缀，用来判断当前图是不是拍的 */
const CAM_PATH_PREFIX = 'cache/pick/cam/'

/** 是否在 App 容器内 */
const host = isNativeAvailable()
/** 模型状态源（只读；状态由原生推送实时更新） */
const models = useModelsStore()
/** 识别用的模型 */
const model = computed(() => models.get(MODEL_ID))

/** 当前图片 */
const image = shallowRef<PickedImage | null>(null)
/** 识别结果 */
const result = shallowRef<ImageClassifyResult | null>(null)
/** 选中的候选下标，-1 表示没选 */
const selected = ref(-1)
/** 识别中 */
const busy = ref(false)
/** 本页已识别次数，用于发热提示 */
const count = ref(0)
/** 本次识别已等待毫秒 */
const elapsed = ref(0)
/** 忙碌计时器 */
let tick: ReturnType<typeof setInterval> | null = null
// CLIP 识物只有一次前向、无法中途打断：识别中不让浮起（动作栏只是禁用按钮，不会自动汇报）
useFloatBusy(() => busy.value)

/** 是否已就绪（模型装好，可以拍照/选图） */
const ready = computed(() => stage.value === 'ready')

/** 页面阶段 */
const stage = computed(() => stageOf(host, model.value?.state ?? 'absent'))
/** 结果视图 */
const view = computed(() => (result.value ? buildView(result.value, selected.value) : null))
/** 易混提示 */
const hints = computed(() => (result.value ? matchHints(result.value.items) : []))
/** 顶部大字的颜色变量 */
const headColor = computed(() => (view.value?.headline.category ? `var(${view.value.headline.category.colorVar})` : ''))

/** 开始忙碌计时 */
function startTick(): void {
  elapsed.value = 0
  const t0 = Date.now()
  tick = setInterval(() => (elapsed.value = Date.now() - t0), TICK_MS)
}

/** 停止忙碌计时 */
function stopTick(): void {
  if (tick !== null) clearInterval(tick)
  tick = null
}

/** 识别当前图片；进行中不重复触发 */
async function classify(img: PickedImage): Promise<void> {
  if (busy.value) return
  busy.value = true
  result.value = null
  selected.value = -1
  startTick()
  try {
    const r = await aiClassifyImage(await resolveImagePath(img), TOP_K)
    count.value += 1
    result.value = r
    selected.value = defaultSelection(r)
  } catch (e) {
    const f = classifyFailure(e)
    showToast(f.text)
  } finally {
    stopTick()
    busy.value = false
  }
}

/** 当前图是否是拍照产物（原生拍前会清旧文件，所以这类图随之失效） */
function isCamImage(img: PickedImage | null): boolean {
  return !!img?.path?.startsWith(CAM_PATH_PREFIX)
}

/** 丢掉当前图与结果（结果只在内存，不留历史） */
function dropCurrent(): void {
  image.value?.release()
  image.value = null
  result.value = null
  selected.value = -1
}

/** 采用新选到的图：释放旧图、识别；来自相册时顺手清掉旧的拍照文件（拍照产物由原生拍前清理，不能在这清） */
async function accept(got: PickedImage): Promise<void> {
  image.value?.release()
  image.value = got
  if (!isCamImage(got)) void clearCamera()
  await classify(got)
}

/** 拍照并立刻识别；取消时若旧图是拍的（原生拍前已清掉文件）就一并丢掉 */
async function takePhoto(): Promise<void> {
  if (busy.value) return
  const hadCam = isCamImage(image.value)
  try {
    const r = await captureCamera({ modes: ['photo'] })
    if (isCancelled(r) || isAlbum(r) || r.kind !== 'image') {
      if (hadCam) dropCurrent()
      return
    }
    await accept(cameraItemToPicked(r))
  } catch (e) {
    if (hadCam) dropCurrent()
    showToast((e as { message?: string }).message ?? '拍照失败')
  }
}

/** 从自带相册页单选一张并立刻识别 */
async function fromAlbum(): Promise<void> {
  if (busy.value) return
  try {
    const got = (await pickImages({ edit: EDIT_BASIC, multiple: false }))[0]
    if (got) await accept(got)
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 点候选：采纳该物品 */
function adopt(i: number): void {
  selected.value = i
}

/** 供宿主页的底部动作栏调用 */
defineExpose({ takePhoto, fromAlbum, ready, busy })

onBeforeUnmount(() => {
  stopTick()
  image.value?.release()
  void clearCamera()
})
</script>

<template>
  <div class="tool-page">
    <!-- 预览：任何阶段都在顶部，1:1 铺满容器宽度 -->
    <tool-group>
      <div class="preview">
        <img v-if="image" class="preview__img" :src="image.url" alt="待识别图片" />
        <van-icon v-else name="photo-o" class="preview__empty" />
      </div>
      <p v-if="busy" class="tool-hint preview__busy">{{ busyText(elapsed) }}</p>
    </tool-group>

    <!-- 非宿主 -->
    <tool-group v-if="stage === 'noHost'" class="gate">
      <div class="gate__icon">📱</div>
      <p class="gate__title">{{ NO_HOST_TEXT }}</p>
      <p class="tool-hint">识别模型跑在手机上，桌面浏览器用不了。</p>
    </tool-group>

    <!-- 模型未就绪：下载归模型选择器 / AI 中心，这里只提示 -->
    <tool-group v-else-if="stage === 'notReady'" class="gate">
      <div class="gate__icon">🗑️</div>
      <p class="gate__title">识别模型还没准备好</p>
      <p class="tool-hint">请先下载模型，进度可在 AI 中心查看。</p>
    </tool-group>

    <!-- 已就绪：选图与结果 -->
    <template v-else>
      <template v-if="view">
        <div
          class="hero"
          :class="{ 'hero--pending': view.headline.kind === 'pending' }"
          :style="view.headline.category ? { background: headColor } : undefined"
          aria-live="polite"
        >
          <span v-if="view.headline.category" class="hero__icon" aria-hidden="true">{{ view.headline.category.icon }}</span>
          <div class="hero__title">{{ view.headline.title }}</div>
          <div v-if="view.headline.sub" class="hero__sub">{{ view.headline.sub }}</div>
        </div>

        <tool-group :title="`${result?.uncertain && selected < 0 ? '更像哪一个？点一下' : '可能是这些，点选更像的'}`">
          <div class="cands" :class="{ 'cands--hot': result?.uncertain && selected < 0 }">
            <button
              v-for="(c, i) in view.cards"
              :key="c.id"
              type="button"
              class="cand"
              :class="{ 'cand--on': c.selected }"
              :aria-pressed="c.selected"
              @click="adopt(i)"
            >
              <span class="cand__head">
                <span class="cand__name">{{ c.nameZh }}</span>
                <span class="cand__tag" :style="{ background: `var(${c.category.colorVar})` }">{{ c.category.name }}</span>
              </span>
              <span class="cand__en">{{ c.nameEn }}</span>
              <span class="cand__track"><span class="cand__bar" :style="{ width: c.bar + '%' }" /></span>
            </button>
          </div>
          <p v-for="h in hints" :key="h" class="hint">💡 {{ h }}</p>
        </tool-group>
      </template>

      <p v-if="shouldWarnHeat(count)" class="tool-hint warm">{{ HEAT_TEXT }}</p>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.gate {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-3;
  text-align: center;

  &__icon {
    font-size: 40px;
  }

  &__title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
}

/* 预览区：宽度铺满容器，高度跟宽度 1:1 */
.preview {
  aspect-ratio: 1 / 1;
  width: 100%;
  margin-bottom: $space-3;
  overflow: hidden;
  border-radius: 10px;

  &__img,
  &__empty {
    width: 100%;
    height: 100%;
  }

  &__img {
    object-fit: cover;
  }

  &__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 64px;
    color: var(--c-text-muted);
    background: var(--c-surface-active);
  }

  &__busy {
    margin: 0 0 $space-3;
    text-align: center;
  }
}

.hero {
  padding: $space-5 $space-4;
  color: var(--c-waste-on);
  text-align: center;
  background: var(--c-surface-active);
  border-radius: var(--tool-card-radius);

  &--pending {
    color: var(--c-text);
    border: 1px dashed var(--c-border);
  }

  &__icon {
    font-size: 36px;
  }

  &__title {
    font-size: 28px;
    font-weight: 700;
    line-height: 1.3;
  }

  &--pending &__title {
    font-size: 18px;
  }

  &__sub {
    margin-top: 4px;
    font-size: 13px;
    opacity: 0.9;
  }
}

.cands {
  display: flex;
  flex-direction: column;
  gap: $space-2;

  &--hot .cand {
    border-color: var(--c-primary);
  }
}

.cand {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 64px;
  padding: $space-3;
  font: inherit;
  color: var(--c-text);
  text-align: left;
  cursor: pointer;
  background: var(--c-surface);
  border: 2px solid var(--c-border);
  border-radius: 12px;

  &--on {
    background: var(--c-surface-active);
    border-color: var(--c-primary);
  }

  &__head {
    display: flex;
    width: 100%;
    gap: $space-2;
    align-items: center;
    justify-content: space-between;
  }

  &__name {
    font-size: 16px;
    font-weight: 600;
  }

  &__tag {
    flex: none;
    padding: 2px 8px;
    font-size: 12px;
    color: var(--c-waste-on);
    border-radius: 10px;
  }

  &__en {
    font-size: 12px;
    color: var(--c-text-muted);
  }

  &__track {
    display: block;
    width: 100%;
    height: 6px;
    background: var(--c-border);
    border-radius: 3px;
  }

  &__bar {
    display: block;
    height: 100%;
    background: var(--c-primary);
    border-radius: 3px;
  }
}

.hint {
  margin: $space-3 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--c-warn-text);
  padding: $space-2 $space-3;
  background: var(--c-warn-bg);
  border-radius: 8px;
}

.warm {
  text-align: center;
}
</style>
