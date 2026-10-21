<script setup lang="ts">
// 翻译：上=源语言+输入；中=交换；下=目标语言+复制+结果；底部动作栏=AI 模型、拍照、相册、翻译。
// 拍照/相册选了图就进入图片模式：输入框换成图片，点「翻译」逐张识别并翻译，处理中禁用翻译按钮。
// 用所选提供者（L1 NLLB / L2 Qwen）在页内出结果；可选项、提供者 id、语言清单都来自 AI 目录（原生 native.ai.providers 的报价），不写死。
// 模型状态只读 store（经目录），下载/删除/校验都在 AI 中心，本页不碰。
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showFailToast, showSuccessToast } from 'vant'
import BottomActions from '@/shared/BottomActions.vue'
import { createToolStorage } from '@/shared/toolStorage'
import { useFloatBusy } from '@/shared/useFloatPause'
import ModelPicker from '@/shared/ModelPicker.vue'
import { copyText } from '@/shared/clipboard'
import { AI_CENTER_PATH, MSG_NO_MODEL, type PickerSection } from '@/shared/modelPicker'
import { aiTranslate, isAiCancelled } from '@/native/ai'
import { useAiCatalog } from '@/native/useAiCatalog'
import { sessionProviderOf } from '@/shared/aiCatalog'
import { TEXT_MAX } from './data'
import LanguagePicker from '@/shared/LanguagePicker.vue'
import { allowsAuto, AUTO_CODE, AUTO_LANG, coercePair, LANGS, langName, pickLang, srcLabel, supportedOf, swapLangs } from '@/shared/languages'
import { isLatestRun, MSG_NO_PROVIDER, readPair, swapTexts, translateErrorMessage, unrecognizedTip, writePair } from './logic'
import { useModelWarmup } from './useModelWarmup'
import PhotoTranslate from './PhotoTranslate.vue'
import { useOutHeight } from './outHeight'
import { isPairSupported, MSG_SHORT_TO_QWEN, PROVIDER_QWEN, routeShort } from './shortInput'

/** 本工具 id（与 registry 一致） */
const TOOL_ID = 'translate'
/** 文字识别工具 id（图片模式下选择器多一组 OCR 模型） */
const OCR_TOOL_ID = 'ocr'
/** 动作项 key */
/** 路由器：无可用模型时跳 AI 中心 */
const router = useRouter()

/** 点「无可用模型，去查看」：去 AI 中心 */
function goAiCenter(): void {
  void router.push(AI_CENTER_PATH)
}

/** 本工具的持久缓存 */
const store = createToolStorage(TOOL_ID)
/** 输入文字 */
const input = ref('')
/** 源/目标语言（从本地偏好恢复） */
const pair = ref(readPair(store))
/** 译文 */
const result = ref('')
/** 译文区元素与它的高度（页面高度 - pageY - 操作栏 - 16） */
const outEl = ref<HTMLElement | null>(null)
const outHeight = useOutHeight(outEl)
/** 最近一次翻译识别出的源语言码（auto 时用于显示与交换） */
const detected = ref<string[]>([])
/** 红色小字提示（部分字符无法识别），空串表示不显示 */
const warnMsg = ref('')
/** 结果下方的普通小提示（如已改用大模型），空串表示不显示 */
const tipMsg = ref('')
/** 失败提示（人话），空串表示没有 */
const errMsg = ref('')
/** 正在翻译或转交 */
const busy = ref(false)
/** 当前翻译的取消控制器 */
let controller: AbortController | null = null
/** 翻译序号：丢弃已被取消或过期的结果 */
let seq = 0

/** 本工具的 AI 目录：只含走 native.ai.translate 的翻译提供者 */
const catalog = useAiCatalog(TOOL_ID)
/** 当前选择值（提供者 id） */
const choice = catalog.choice
/** 提供者是否已探测过；探测前不提示“无可用模型”，免得闪一下 */
const catalogReady = catalog.ready
/** 所选翻译提供者 id；还没探测到或没有可选项为 undefined */
const providerId = computed(() => catalog.current.value?.providerId)
/** 当前所选翻译模型是否已安装（状态来自模型 store） */
const modelReady = computed(() => catalog.current.value?.status === 'ready')
/** 图片翻译区实例（拍照/相册/翻译在图片模式下由它执行） */
const photo = ref<InstanceType<typeof PhotoTranslate> | null>(null)
/** 是否处于图片模式（已选了图） */
const imageMode = computed(() => !!photo.value?.hasImages)
/** 图片是否正在处理 */
const photoBusy = computed(() => !!photo.value?.busy)
/** 是否有事在忙（文字或图片） */
const working = computed(() => busy.value || photoBusy.value)
// 拍照翻译处理中（识别+翻译，停用会被中止）不让浮起；文字翻译已由主按钮 loading 自动汇报
useFloatBusy(() => photoBusy.value)
/** 主按钮能否点：图片模式要有图、两个模型就绪且不在处理（处理中禁用）；文字模式有文字且模型就绪（翻译中可点以取消） */
const canGo = computed(() => {
  if (imageMode.value) return !photoBusy.value && !!photo.value?.modelsReady && !tooFewLangs.value
  return busy.value || (!!input.value.trim() && modelReady.value && !tooFewLangs.value)
})
/** 主按钮是否处于「取消」态：只有文字翻译进行中才可取消 */
const canCancel = computed(() => busy.value && !imageMode.value)
/** 主按钮文案：文字翻译中变「取消翻译」，其余都是「翻译」 */
const goText = computed(() => (canCancel.value ? '取消翻译' : '翻译'))
/** 选择器分组：图片模式下加一组文字识别模型 */
const sections = computed<PickerSection[]>(() => {
  const list: PickerSection[] = [{ toolId: TOOL_ID, title: '翻译模型' }]
  if (imageMode.value) list.push({ toolId: OCR_TOOL_ID, title: '文字识别模型' })
  return list
})
/** 底部动作栏：AI 选择器（插槽）、拍照、相册、翻译 */
/** 顶部「无可用模型」提示是否显示：文字模式看翻译模型，图片模式看翻译+识别两个 */
const showMissing = computed(() => (imageMode.value ? !!photo.value?.showMissing : catalogReady.value && !modelReady.value))

/** 当前提供者的翻译约束（语言清单、能否 auto），由原生报价给出 */
const constraints = computed(() => catalog.current.value?.constraints)
/** 当前模型支持的语言码 */
const supported = computed(() => supportedOf(constraints.value))
/** 当前模型是否支持源语言自动检测 */
const autoOk = computed(() => allowsAuto(constraints.value))
/** 源语言选择器的候选目录：支持 auto 时 auto 排最前；目标选择器仍用 LANGS */
const srcLangs = computed(() => (autoOk.value ? [AUTO_LANG, ...LANGS] : LANGS))
/** 源语言选择器的可选码：支持集合 + auto（若支持） */
const srcSupported = computed(() => (autoOk.value ? [AUTO_CODE, ...supported.value] : supported.value))
/** 源语言行显示名（auto 且识别出语言时带括号） */
const srcName = computed(() => srcLabel(pair.value.src, detected.value))
/** 当前模型支持的语言少于 2 种：没法互译，禁用翻译 */
const tooFewLangs = computed(() => supported.value.length < 2)

/** 用当前模型支持的语言纠正语言对（不变则不触发写回）；约束还没从原生拿到时不动，免得把存下的 auto 误纠掉 */
function fixPair(): void {
  if (!constraints.value) return
  const next = coercePair(pair.value, supported.value, autoOk.value)
  if (next.src !== pair.value.src || next.tgt !== pair.value.tgt) pair.value = next
}
fixPair()
watch([constraints, supported, autoOk], fixPair)
watch(pair, (v) => writePair(store, v))
onBeforeUnmount(() => controller?.abort())
// 进入时预热所选模型；换模型先卸旧的再预热新的；离开（停用或卸载）时卸载回收内存。只跟随声明了会话能力的提供者
const warmup = useModelWarmup(
  computed(() => sessionProviderOf(catalog.current.value)),
  modelReady,
)
// 输入改了：之前识别出的语言与「无法识别」提示都作废
watch(input, () => {
  detected.value = []
  warnMsg.value = ''
  tipMsg.value = ''
})
onDeactivated(cancel)
// 切换模型：有输入且能翻译就取消旧请求并用新模型立刻重翻，不等用户再点
watch(choice, () => {
  if (imageMode.value || !input.value.trim() || modelReady.value === false || tooFewLangs.value) return
  cancel()
  void translate()
})

/** 取消进行中的翻译（若有） */
function cancel(): void {
  seq++
  controller?.abort()
  controller = null
  busy.value = false
}

/** 主按钮：图片模式跑图片翻译；文字模式翻译中则取消，否则开始翻译 */
function go(): void {
  if (imageMode.value) return void photo.value?.run()
  if (busy.value) return cancel()
  void translate()
}

/** 动作栏点击分发 */

/** 用本地模型翻译 */
async function translate(): Promise<void> {
  const text = input.value.trim()
  if (!text) return
  const my = ++seq
  const ac = new AbortController()
  controller = ac
  busy.value = true
  errMsg.value = ''
  result.value = ''
  warnMsg.value = ''
  tipMsg.value = ''
  detected.value = []
  try {
    // 首次进入时探测可能还没回来，等它一次；找不到提供者就明说，不悄悄换成别的模型
    if (!catalogReady.value) await catalog.refresh()
    const provider = providerId.value
    if (!provider) {
      if (my === seq) errMsg.value = MSG_NO_PROVIDER
      return
    }
    // 极短输入：先查短语表直接出译文，其次在 Qwen 就绪且支持该语言对时改用 Qwen；其余照所选
    const qwen = catalog.items.value.find((i) => i.providerId === PROVIDER_QWEN)
    const route = routeShort({
      provider,
      text,
      src: pair.value.src,
      tgt: pair.value.tgt,
      qwenReady: qwen?.status === 'ready',
      qwenSupportsPair: !!qwen && isPairSupported(qwen.constraints, pair.value),
    })
    // 等探测期间可能已被取消或切换了模型：旧结果不得覆盖新状态
    if (!isLatestRun(my, seq)) return
    if (route.kind === 'phrase') {
      result.value = route.text
      return
    }
    const useQwen = route.kind === 'qwen'
    // 本页改走 Qwen：登记为额外占用，离页时与 NLLB 一起卸载
    if (useQwen) warmup.occupy(PROVIDER_QWEN)
    const r = await aiTranslate({ text, src: pair.value.src, tgt: pair.value.tgt, provider: useQwen ? PROVIDER_QWEN : provider }, ac.signal)
    if (isLatestRun(my, seq)) {
      if (useQwen) tipMsg.value = MSG_SHORT_TO_QWEN
      result.value = r.text
      detected.value = r.detectedSrc ?? []
      warnMsg.value = unrecognizedTip(r.unrecognized)
    }
  } catch (e) {
    if (my === seq && !isAiCancelled(e)) errMsg.value = translateErrorMessage(e)
  } finally {
    if (my === seq) {
      busy.value = false
      controller = null
    }
  }
}

/** 选定语言：与另一侧相同时另一侧自动换成这一侧原来的（见 pickLang） */
function onPick(side: 'src' | 'tgt', code: string): void {
  detected.value = []
  pair.value = pickLang(pair.value, side, code, supported.value, autoOk.value)
}

/** 交换语言，同时交换输入框与译文框的内容（有译文才交换）；不重新翻译，也不清空 */
function swap(): void {
  cancel()
  pair.value = swapLangs(pair.value, detected.value, supported.value)
  const t = swapTexts(input.value, result.value, TEXT_MAX)
  input.value = t.input
  result.value = t.result
  // 原来的错误提示、识别出的语言和「无法识别」提示都属于旧译文，换位后作废
  errMsg.value = ''
  warnMsg.value = ''
  tipMsg.value = ''
  detected.value = []
}

/** 清空输入和输出（含图片）：取消进行中的翻译，清掉输入、译文、错误提示和「没人接手」的备选入口 */
function clearAll(): void {
  cancel()
  photo.value?.clear()
  input.value = ''
  result.value = ''
  errMsg.value = ''
  warnMsg.value = ''
  tipMsg.value = ''
  detected.value = []
}

/** 复制文本 */
async function copy(text: string): Promise<void> {
  if (await copyText(text)) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}

</script>

<template>
  <div class="tool-page">
    <!-- 无可用模型：放在页面最顶部，右侧箭头，点击去 AI 中心 -->
    <van-notice-bar v-if="showMissing" mode="link" wrapable :scrollable="false" left-icon="info-o" @click="goAiCenter">{{ MSG_NO_MODEL }}</van-notice-bar>

    <!-- 上：源语言行（卡片外），右侧清空按钮 -->
    <div class="tr-row">
      <language-picker :model-value="pair.src" :languages="srcLangs" :supported="srcSupported" title="源语言" @update:model-value="onPick('src', $event)">
        <template #default="{ show }">
          <button type="button" class="tr-lang" :aria-label="`源语言：${srcName}`" @click="show">
            <span class="tr-lang__hint">源语言</span>
            <span class="tr-lang__name">{{ srcName }}</span>
            <van-icon name="arrow-down" />
          </button>
        </template>
      </language-picker>
      <button type="button" class="tr-copy" aria-label="清空输入和输出" :disabled="working || (!input && !result && !errMsg && !imageMode)" @click="clearAll">
        <van-icon name="delete-o" />
        <span>清空</span>
      </button>
    </div>
    <!-- 文字模式：输入框；图片模式：换成图片（扫描、叠译文都在里面） -->
    <tool-group v-show="!imageMode">
      <van-field v-model="input" type="textarea" rows="4" autosize placeholder="粘贴或输入要翻译的文字" :maxlength="TEXT_MAX" show-word-limit />
    </tool-group>
    <tool-group v-show="imageMode">
      <photo-translate ref="photo" :pair="pair" @use-qwen="warmup.occupy(PROVIDER_QWEN)" />
    </tool-group>

    <!-- 中：交换按钮（靠右，无修饰） -->
    <div class="tr-mid">
      <button type="button" class="tr-swap" aria-label="交换源语言与目标语言" @click="swap">
        <van-icon name="exchange" class="tr-swap__icon" />
      </button>
    </div>

    <!-- 下：目标语言行（卡片外）+ 复制；下面是结果卡片 -->
    <div class="tr-row">
      <language-picker :model-value="pair.tgt" :supported="supported" title="目标语言" @update:model-value="onPick('tgt', $event)">
        <template #default="{ show }">
          <button type="button" class="tr-lang" :aria-label="`目标语言：${langName(pair.tgt)}`" @click="show">
            <span class="tr-lang__hint">译成</span>
            <span class="tr-lang__name">{{ langName(pair.tgt) }}</span>
            <van-icon name="arrow-down" />
          </button>
        </template>
      </language-picker>
      <button type="button" class="tr-copy" aria-label="复制译文" :disabled="imageMode ? !photo?.hasText : !result" @click="copy(imageMode ? photo?.translatedText ?? '' : result)">
        <van-icon name="records-o" />
        <span>复制</span>
      </button>
    </div>
    <tool-group>
      <div ref="outEl" class="tr-out" dir="auto" :style="{ height: `${outHeight}px` }">
        <!-- 图片模式：汇总所有图片的译文，保留各自换行 -->
        <template v-if="imageMode">
          <p v-if="photo?.translatedText" class="tr-out__text">{{ photo.translatedText }}</p>
          <p v-else class="tr-out__empty">译文会显示在这里</p>
        </template>
        <van-loading v-else-if="busy" size="20px">翻译中，请稍候…</van-loading>
        <p v-else-if="errMsg" class="tr-out__err">{{ errMsg }}</p>
        <template v-else-if="result">
          <p class="tr-out__text">{{ result }}</p>
          <p v-if="warnMsg" class="tr-out__warn">{{ warnMsg }}</p>
          <p v-if="tipMsg" class="tr-out__tip">{{ tipMsg }}</p>
        </template>
        <p v-else class="tr-out__empty">译文会显示在这里</p>
      </div>
    </tool-group>

    <!-- 底部动作栏：左 AI（翻译模型 + 图片模式下的识别模型），中拍照、相册，右主按钮「翻译」 -->
    <bottom-actions :main-loading="busy"
      ai
      album
      photo
      main
      :main-text="goText"
      :main-type="canCancel ? 'danger' : 'primary'"
      :disabled="{ album: working, photo: working, main: !canGo }"
      @album="photo?.fromAlbum()"
      @photo="photo?.fromCamera()"
      @main="go"
    >
      <template #ai>
        <model-picker :sections="sections" variant="bar" />
      </template>
    </bottom-actions>
  </div>
</template>

<style lang="scss" scoped>
// 语言行（在卡片外）：语言选择在左，操作按钮在右；贴着下面的卡片（抵消页面的行间距），一眼看出它是这张卡片的标题
.tr-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 36px;
  margin-bottom: calc(var(--tool-gap) * -1);
  padding: 0 $space-2;
}

.tr-lang {
  display: inline-flex;
  align-items: center;
  gap: $space-2;
  min-height: 36px;
  padding: 0;
  font-size: 13px;
  color: var(--c-text);
  background: none;
  border: 0;
}

.tr-lang__hint {
  font-size: 13px;
  color: var(--c-text-muted);
}

// 语言名与 label（.tr-lang__hint）同字号，靠加粗和主色区分
.tr-lang__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-primary);
}

// 中段：交换按钮靠右；按钮缩小 1/3（zoom 同时缩小点击区）
.tr-mid {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 $space-2;
}

.tr-swap {
  zoom: 0.667;
}

// 交换按钮：无修饰（无背景、无边框），只留主色图标
.tr-swap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  color: var(--c-primary);
  background: none;
  border: 0;
  -webkit-tap-highlight-color: transparent;
}

.tr-swap__icon {
  font-size: 22px;
  transform: rotate(90deg);
}

.tr-copy {
  display: inline-flex;
  align-items: center;
  gap: $space-1;
  min-height: 36px;
  padding: 0 $space-2;
  font-size: 13px;
  color: var(--c-primary);
  background: none;
  border: 0;

  &:disabled {
    color: var(--c-text-muted);
    opacity: 0.5;
  }
}

// 结果区：文字可选可复制
.tr-out {
  overflow-y: auto;
  padding-top: $space-2;
  font-size: 16px;
  line-height: 1.6;
  color: var(--c-text);
  word-break: break-word;
  user-select: text;
}

.tr-out__text,
.tr-out__err,
.tr-out__empty {
  margin: 0;
  white-space: pre-wrap;
}

.tr-out__err {
  font-size: 14px;
  color: var(--c-error);
}

// 译文下方的普通小字提示
.tr-out__tip {
  margin: $space-1 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--c-text-muted);
}

// 译文下方的小字提示（红色）
.tr-out__warn {
  margin: $space-1 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--c-error);
}

.tr-out__empty {
  font-size: 14px;
  color: var(--c-text-muted);
}

.tr-gap {
  margin-top: $space-3;
}
</style>
