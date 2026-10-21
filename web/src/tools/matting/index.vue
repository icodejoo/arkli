<script setup lang="ts">
// 抠图：选图 → 本地模型（人像 MODNet / 通用 U2Net-p）→ 透明 PNG；棋盘格预览，可换底色，保存 PNG（透明）或 JPG（带底色）、分享
import BottomActions from '@/shared/BottomActions.vue'
import ModelPicker from '@/shared/ModelPicker.vue'
import CellPicker from '@/shared/CellPicker.vue'
import ColorPicker from '@/shared/ColorPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { isHexColor, oneOf } from '@/shared/persistValidators'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import { computed, onBeforeUnmount, onDeactivated, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import { call } from '@/native/bridge'
import { aiMatting, AiNotReadyError, fetchAiResult, isAiCancelled, type MattingRefine, type MattingResult } from '@/native/ai'
import { saveCachedFile } from '@/native/media'
import { share } from '@/native/system'
import { useAiCatalog } from '@/native/useAiCatalog'
import { canvasToBlob, createCanvas, EDIT_BASIC, pickImages, previewBlob, releaseCanvas, saveBlob, writeBlobToCache, type PickedImage } from '@/shared/image-io'
import { shootPhoto } from '@/shared/shootPhoto'
import { aiErrorText, handleNotReady, resolveImagePath } from '@/tools/_ai/aiImage'
import { useModelGate } from '@/shared/modelGate'
import {
  BG_OPTIONS,
  DEFAULT_CUSTOM_HEX,
  JPEG_QUALITY,
  MATTING_MODES,
  MIME_JPEG,
  MIME_PNG,
  MODE_HINTS,
  MODE_LABELS,
  PROVIDER_OF_MODE,
  REFINE_HINT,
  REFINE_OPTIONS,
  bgColorOf,
  DEFAULT_REFINE,
  normalizeRefine,
  REFINE_STORAGE_KEY,
  modeOfProvider,
  outputName,
  resultUrl,
  shouldRerunOnRefine,
  summaryOf,
  type BgKind,
} from './logic'

/** 本工具 id（与 registry 一致） */
const TOOL_ID = 'matting'
/** 本工具的 AI 目录：模型状态只读（下载、删除、校验都在 AI 中心） */
const catalog = useAiCatalog(TOOL_ID)
/** 提供者是否已探测过；探测前不提示“无可用模型”，免得闪一下 */
const catalogReady = catalog.ready
/** 当前模式：每个模式各是一个提供者，所以模式就是目录里当前选中的提供者 */
const mode = computed(() => modeOfProvider(catalog.current.value?.providerId))
/** 当前模式的模型是否已安装 */
const modelReady = computed(() => catalog.current.value?.status === 'ready')
/** 模型缺失闸门：未就绪时点按钮弹「去下载」对话框 */
const { requireModel, promptDownload } = useModelGate()
/** 标签页下标 */
const tabIndex = computed(() => MATTING_MODES.indexOf(mode.value))

/** 已选图片 */
const image = shallowRef<PickedImage | null>(null)
/** 处理中 */
const busy = ref(false)
/** 抠图结果 */
const result = shallowRef<MattingResult | null>(null)
/** 背景选择器选项 */
const BG_CHOICES: readonly CellOption[] = BG_OPTIONS.map((o) => ({ value: o.kind, label: o.label }))
/** 本工具的持久缓存 */
const store = createToolStorage(TOOL_ID)
/** 背景选项 */
const bgKind = usePersistedRef<BgKind>(store, 'bgKind', 'transparent', oneOf(BG_CHOICES))
/** 自定义背景色 */
const customHex = usePersistedRef(store, 'customHex', DEFAULT_CUSTOM_HEX, isHexColor)
// 旧版把细化档位直接存在单独键里，一次性迁入
store.adoptLegacy(REFINE_STORAGE_KEY, 'refine', normalizeRefine)
/** 边缘细化档位（自动记住，没有记录用默认“强”） */
const refine = usePersistedRef<MattingRefine>(store, 'refine', DEFAULT_REFINE, oneOf(REFINE_OPTIONS))
/** 细化档位在分段控件里的下标 */
const refineIndex = computed(() => REFINE_OPTIONS.findIndex((o) => o.value === refine.value))
/** 当前抠图的取消控制器 */
let controller: AbortController | null = null
/** 运行序号：取消后用户立刻再点开始，旧调用的收尾不能覆盖新调用的状态 */
let runId = 0

/** 当前背景颜色，透明为 null */
const bgColor = computed(() => bgColorOf(bgKind.value, customHex.value))
/** 结果图的页面地址 */
const resultSrc = computed(() => (result.value ? resultUrl(result.value.path) : ''))
/** 结果摘要 */
const summary = computed(() => (result.value ? summaryOf(result.value) : ''))
/** 当前模式的说明 */
const modeHint = computed(() => MODE_HINTS[mode.value])

/** 切换模式：选中对应提供者；换模式后旧结果与新模式对不上，清掉 */
function onTab(index: number): void {
  const provider = PROVIDER_OF_MODE[MATTING_MODES[index]]
  const item = catalog.items.value.find((i) => i.providerId === provider)
  if (!item || item.key === catalog.choice.value) return
  catalog.set(item.key)
  result.value = null
}

/**
 * 切换边缘细化档位：先记住；已经出过图就自动重抠（正在抠的先取消再重跑），还没出图只记住。
 *
 * @param index 分段控件里被选中的下标
 */
function onRefine(index: number): void {
  const next = REFINE_OPTIONS[index]?.value
  if (!next) return
  const prev = refine.value
  refine.value = next
  if (!shouldRerunOnRefine(prev, next, result.value !== null) || !image.value) return
  if (busy.value) cancel()
  void run()
}

/** 采用新图：释放旧图，换图后清掉旧结果 */
function adopt(img: PickedImage): void {
  image.value?.release()
  image.value = img
  result.value = null
}

/** 相册选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ edit: EDIT_BASIC, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got.length) adopt(got[0])
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照 */
async function shoot(): Promise<void> {
  const got = await shootPhoto()
  if (got) adopt(got)
}

/** 开始抠图 */
async function run(): Promise<void> {
  if (!(await requireModel(modelReady.value))) return
  if (!image.value || busy.value) return
  const my = ++runId
  busy.value = true
  controller = new AbortController()
  const ctl = controller
  try {
    const path = await resolveImagePath(image.value)
    const r = await aiMatting(path, mode.value, ctl.signal, undefined, refine.value)
    if (my === runId) result.value = r
  } catch (e) {
    if (isAiCancelled(e) || my !== runId) return
    // 撞上“模型未就绪”：重新探测目录，提示条随之出现；状态仍显示可用时给一句通用提示
    if (e instanceof AiNotReadyError) await handleNotReady(catalog.refresh, () => catalog.current.value?.status === 'ready', showToast, promptDownload)
    else showToast(aiErrorText(e))
  } finally {
    if (my === runId) {
      controller = null
      busy.value = false
    }
  }
}

/** 取消处理：立刻放开按钮，用户可马上重新开始（原生一次前向不可中途打断，最迟约 0.8 秒后真正停下） */
function cancel(): void {
  controller?.abort()
  controller = null
  runId++
  busy.value = false
}

/** 把透明 PNG 铺在底色上合成 JPG */
async function composeOnColor(path: string, hex: string): Promise<Blob> {
  const bmp = await createImageBitmap(await fetchAiResult(path))
  const canvas = createCanvas(bmp.width, bmp.height)
  try {
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = hex
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0)
    return await canvasToBlob(canvas, MIME_JPEG, JPEG_QUALITY)
  } finally {
    bmp.close()
    releaseCanvas(canvas)
  }
}

/** 预览：透明直接用原生预览缓存里的 PNG，带底色先合成再预览 */
async function preview(): Promise<void> {
  const r = result.value
  if (!r) return
  try {
    const hex = bgColor.value
    if (!hex) {
      await call('native.image.preview', { paths: [r.path] })
      return
    }
    await previewBlob(await composeOnColor(r.path, hex), outputName(image.value?.name, 'jpg'))
  } catch (e) {
    showToast((e as { message?: string }).message ?? '预览失败')
  }
}

/** 保存：透明存 PNG，带底色存 JPG */
async function save(): Promise<void> {
  const r = result.value
  if (!r) return
  try {
    const hex = bgColor.value
    if (!hex) await saveCachedFile(r.path, outputName(image.value?.name, 'png'), MIME_PNG)
    else await saveBlob(await composeOnColor(r.path, hex), outputName(image.value?.name, 'jpg'))
    showToast('已保存到相册')
  } catch (e) {
    showToast((e as { message?: string }).message ?? '保存失败')
  }
}

/** 分享：透明分享 PNG，带底色先合成 JPG 写进缓存再分享 */
async function shareResult(): Promise<void> {
  const r = result.value
  if (!r) return
  try {
    const hex = bgColor.value
    const name = outputName(image.value?.name, hex ? 'jpg' : 'png')
    const path = hex ? await writeBlobToCache(await composeOnColor(r.path, hex), name) : r.path
    if (!(await share({ path, mime: hex ? MIME_JPEG : MIME_PNG, title: name }))) showToast('没能打开分享面板')
  } catch (e) {
    showToast((e as { message?: string }).message ?? '分享失败')
  }
}

/** 离开页面：取消还在跑的处理，释放图片 */
function cleanup(): void {
  controller?.abort()
  image.value?.release()
}

onDeactivated(() => controller?.abort())
onBeforeUnmount(cleanup)
</script>

<template>
  <div class="tool-page">
    <van-tabs :active="tabIndex" class="mt-tabs" type="card" :swipeable="false" :ellipsis="false" @change="onTab">
      <van-tab v-for="m in MATTING_MODES" :key="m" :title="MODE_LABELS[m]" />
    </van-tabs>
    <p class="tool-hint">{{ modeHint }}</p>
    <!-- 边缘细化：四档分段控件，出过图后切换会自动重抠 -->
    <div class="mt-refine">
      <span class="mt-refine__label">边缘细化</span>
      <van-tabs :active="refineIndex" class="mt-refine__tabs" type="card" :swipeable="false" @change="onRefine">
        <van-tab v-for="o in REFINE_OPTIONS" :key="o.value" :title="o.label" />
      </van-tabs>
    </div>
    <p class="tool-hint">{{ REFINE_HINT }}</p>

    <model-missing-notice v-if="catalogReady && !modelReady" />

    <tool-group title="原图">
      <img v-if="image" class="mt-src" :src="image.url" alt="待抠图的图片" />
      <p v-else class="tool-hint">点底部「相册」或「拍照」选一张图。</p>
    </tool-group>

    <tool-group v-if="busy || result" title="抠图结果">
      <div v-if="busy" class="mt-busy">
        <van-loading size="24px" vertical>抠图中…</van-loading>
        <van-button size="small" plain type="default" @click="cancel">取消</van-button>
      </div>
      <template v-else-if="result">
        <!-- 棋盘格（透明）或所选底色，图点击预览 -->
        <div class="mt-stage" :class="{ 'is-checker': !bgColor }" :style="bgColor ? { background: bgColor } : undefined" @click="preview">
          <img class="mt-stage__img" :src="resultSrc" alt="抠图结果" />
        </div>
        <p class="tool-hint">{{ summary }}。点图可全屏预览。</p>
        <cell-picker :model-value="bgKind" title="背景" :options="BG_CHOICES" @update:model-value="bgKind = $event as BgKind" />
        <color-picker v-if="bgKind === 'custom'" v-model="customHex" label="背景色" />
        <p class="tool-hint">透明保存为 PNG；选了底色保存为 JPG。</p>
      </template>
    </tool-group>

    <!-- 底部动作栏：相册 / 拍照选图，保存与分享结果，主按钮开始抠图 -->
    <bottom-actions :main-loading="busy" ai
      :actions="{ save: { disabled: !result || busy }, share: { disabled: !result || busy } }"
      album
      photo
      main
      :main-text="busy ? '处理中' : '开始抠图'"
      :disabled="{ album: busy, photo: busy, main: busy || !image }"
      @album="choose"
      @photo="shoot"
      @save="save"
      @share="shareResult"
      @main="run"
    >
      <template #ai><model-picker :tool-id="TOOL_ID" variant="bar" /></template>
    </bottom-actions>
  </div>
</template>

<style lang="scss" scoped>
/* 模式标签页：与上下内容留出间距 */
.mt-tabs {
  margin-bottom: $space-2;
}

/* 边缘细化：标签在左，分段控件占剩余宽度 */
.mt-refine {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-top: $space-2;

  &__label {
    flex: none;
    font-size: 14px;
  }

  &__tabs {
    flex: 1;
    min-width: 0;
  }
}

/* 原图：自适应宽度 */
.mt-src {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 8px;
}

/* 处理中：转圈加取消按钮 */
.mt-busy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-3;
  padding: $space-4 0;
}

/* 结果舞台：背景是棋盘格或所选底色 */
.mt-stage {
  line-height: 0;
  border-radius: 8px;
  overflow: hidden;

  &.is-checker {
    background-color: #fff;
    background-image:
      linear-gradient(45deg, #d9d9d9 25%, transparent 25%, transparent 75%, #d9d9d9 75%),
      linear-gradient(45deg, #d9d9d9 25%, transparent 25%, transparent 75%, #d9d9d9 75%);
    background-position:
      0 0,
      8px 8px;
    background-size: 16px 16px;
  }

  &__img {
    display: block;
    width: 100%;
    height: auto;
  }
}
</style>
