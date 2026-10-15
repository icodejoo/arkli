<script setup lang="ts">
// 垃圾分类识别：选图 → 本地 CLIP 识物 → 顶部大字分类 + top-3 候选（点哪个就采纳哪个）。
// 模型不随包发布，首次使用先下载（native.model.*）；页面只做装配，逻辑都在 logic.ts。
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { aiClassifyImage, type ImageClassifyResult } from '@/native/ai'
import { useModelState } from '@/native/useModelState'
import { pickImages, type PickedImage } from '@/shared/image-io'
import { resolveImagePath } from '@/tools/_ai/aiImage'
import {
  buildView,
  busyText,
  classifyFailure,
  defaultSelection,
  DISCLAIMER,
  downloadErrorText,
  HEAT_TEXT,
  matchHints,
  megaText,
  MODEL_ID,
  NO_HOST_TEXT,
  progressText,
  shouldWarnHeat,
  sizeLabel,
  speedText,
  stageOf,
  TOP_K,
} from './logic'

/** 忙碌文案刷新间隔（毫秒） */
const TICK_MS = 500

/** 是否在 App 容器内 */
const host = isNativeAvailable()
/** 模型状态与下载操作 */
const model = useModelState(MODEL_ID)

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
/** 已确认过计费网络，不再重复问 */
let meteredOk = false
/** 已静默校验过一次，避免校验失败后反复触发 */
let verifyTried = false
/** 忙碌计时器 */
let tick: ReturnType<typeof setInterval> | null = null

/** 页面阶段 */
const stage = computed(() => stageOf(host, model.ready.value, model.state.value, model.status.value?.phase))
/** 结果视图 */
const view = computed(() => (result.value ? buildView(result.value, selected.value) : null))
/** 易混提示 */
const hints = computed(() => (result.value ? matchHints(result.value.items) : []))
/** 下载错误文案，没有错误为空 */
const downloadError = computed(() => (model.error.value ? downloadErrorText(model.error.value.code) : ''))
/** 下载百分比 0~100 */
const percent = computed(() => Math.round(model.progress.value * 100))
/** 模型总大小文案 */
const sizeText = computed(() => sizeLabel(model.status.value?.totalBytes ?? 0))
/** 已装模型占用空间 */
const diskText = computed(() => megaText(model.status.value?.diskBytes ?? 0))
/** 顶部大字的颜色变量 */
const headColor = computed(() => (view.value?.headline.category ? `var(${view.value.headline.category.colorVar})` : ''))

/** 开始下载；计费网络先取消再确认，确认后续传 */
async function download(): Promise<void> {
  await model.start()
  if (!model.meteredHint.value || meteredOk || !model.downloading.value) return
  await model.cancel()
  try {
    await showConfirmDialog({ title: '正在使用移动网络', message: `模型约 ${sizeText.value}，会用掉流量。继续下载吗？已下载的部分会保留。` })
  } catch {
    return
  }
  meteredOk = true
  await model.start()
}

/** 删除模型：二次确认，成功后清空结果 */
async function removeModel(): Promise<void> {
  try {
    await showConfirmDialog({ title: '删除识别模型', message: `将释放约 ${diskText.value} 空间，之后想用要重新下载。` })
  } catch {
    return
  }
  await model.remove()
  result.value = null
  selected.value = -1
}

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
    if (f.kind === 'notReady') await model.refresh()
    showToast(f.text)
  } finally {
    stopTick()
    busy.value = false
  }
}

/** 选图并立刻识别 */
async function choose(): Promise<void> {
  if (busy.value) return
  try {
    const got = await pickImages({ onFailed: () => showToast('这张图读不出来，换一张试试') })
    if (!got.length) return
    image.value?.release()
    image.value = got[0]
    await classify(got[0])
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 点候选：采纳该物品 */
function adopt(i: number): void {
  selected.value = i
}

// 文件齐全但没校验过（比如手动放进去的）：静默校验一次再用
watch(
  () => model.state.value,
  (s) => {
    if (s === 'unverified' && !verifyTried) {
      verifyTried = true
      void model.verify()
    }
  },
)

onMounted(() => {
  if (host) void model.refresh()
})

onBeforeUnmount(() => {
  stopTick()
  image.value?.release()
})
</script>

<template>
  <div class="tool-page">
    <!-- 非宿主 -->
    <div v-if="stage === 'noHost'" class="tool-card gate">
      <div class="gate__icon">📱</div>
      <p class="gate__title">{{ NO_HOST_TEXT }}</p>
      <p class="tool-hint">识别模型跑在手机上，桌面浏览器用不了。</p>
    </div>

    <!-- 探测中 -->
    <div v-else-if="stage === 'checking'" class="tool-card gate">
      <van-loading size="24" />
    </div>

    <!-- 需要下载 -->
    <div v-else-if="stage === 'needDownload'" class="tool-card gate">
      <div class="gate__icon">🗑️</div>
      <p class="gate__title">先下载识别模型</p>
      <p class="tool-hint">只需下载一次，之后离线可用；模型不随安装包发布。</p>
      <p v-if="downloadError" class="gate__error" role="alert">{{ downloadError }}</p>
      <van-button type="primary" block round size="large" :loading="model.busy.value" @click="download">
        {{ (model.status.value?.downloadedBytes ?? 0) > 0 ? '继续下载' : '下载识别模型' }}（{{ sizeText }}）
      </van-button>
    </div>

    <!-- 下载中 -->
    <div v-else-if="stage === 'downloading'" class="tool-card gate">
      <p class="gate__title">正在下载识别模型…</p>
      <van-progress :percentage="percent" stroke-width="8" />
      <p class="tool-hint gate__stat">
        <span>{{ model.status.value ? progressText(model.status.value) : '' }}</span>
        <span>{{ speedText(model.status.value?.speedBps) }}</span>
      </p>
      <van-button plain block round size="large" :loading="model.busy.value" @click="model.cancel">取消（已下载的部分会保留）</van-button>
    </div>

    <!-- 校验中 -->
    <div v-else-if="stage === 'verifying'" class="tool-card gate">
      <van-loading size="24" />
      <p class="gate__title">正在检查模型文件…</p>
      <p v-if="downloadError" class="gate__error" role="alert">{{ downloadError }}</p>
    </div>

    <!-- 已就绪：选图与结果 -->
    <template v-else>
      <div class="tool-card">
        <div class="pick">
          <img v-if="image" class="pick__thumb" :src="image.url" alt="待识别图片" />
          <div v-else class="pick__empty">📷</div>
          <div class="pick__side">
            <p class="pick__text">{{ busy ? busyText(elapsed) : image ? '换一张再识别' : '选一张垃圾的照片' }}</p>
            <van-button type="primary" round size="large" :loading="busy" :disabled="busy" @click="choose">
              {{ image ? '换一张' : '从相册选图' }}
            </van-button>
          </div>
        </div>
      </div>

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

        <div class="tool-card">
          <h3 class="tool-card__title">{{ result?.uncertain && selected < 0 ? '更像哪一个？点一下' : '可能是这些，点选更像的' }}</h3>
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
        </div>
      </template>

      <p v-if="shouldWarnHeat(count)" class="tool-hint warm">{{ HEAT_TEXT }}</p>
      <p class="tool-hint foot">{{ DISCLAIMER }}</p>

      <!-- 模型管理 -->
      <div class="tool-card manage">
        <span class="tool-hint">识别模型已安装，占用 {{ diskText }}</span>
        <van-button size="small" plain round :loading="model.busy.value" @click="removeModel">删除模型释放空间</van-button>
      </div>
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

  &__error {
    margin: 0;
    font-size: 13px;
    color: var(--c-error);
  }

  &__stat {
    display: flex;
    justify-content: space-between;
    width: 100%;
  }

  :deep(.van-progress) {
    width: 100%;
  }
}

.pick {
  display: flex;
  gap: $space-3;
  align-items: center;

  &__thumb,
  &__empty {
    flex: none;
    width: 96px;
    height: 96px;
    border-radius: 10px;
  }

  &__thumb {
    object-fit: cover;
  }

  &__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 36px;
    background: var(--c-surface-active);
  }

  &__side {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: $space-2;
    min-width: 0;
  }

  &__text {
    margin: 0;
    font-size: 13px;
    color: var(--c-text-muted);
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

.warm,
.foot {
  text-align: center;
}

.manage {
  display: flex;
  gap: $space-3;
  align-items: center;
  justify-content: space-between;
}
</style>
