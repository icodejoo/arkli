<script setup lang="ts">
// 翻译：上中下三段。上=输入+源语言；中=模型选择+交换；下=目标语言+复制+结果。
// 用本地模型（L1）在页内出结果。
// 模型状态只读 store，下载/删除/校验都在 AI 中心，本页不碰。
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showFailToast, showSuccessToast } from 'vant'
import ModelPicker from '@/shared/ModelPicker.vue'
import { copyText } from '@/shared/clipboard'
import { AI_CENTER_PATH } from '@/shared/modelPicker'
import { aiTranslate } from '@/native/ai'
import { useModelChoice } from '@/native/useModelChoice'
import { useModelsStore } from '@/stores/models'
import { findTool } from '@/tools/registry'
import { NLLB_MODEL_ID, TEXT_MAX } from './data'
import LanguagePicker from '@/shared/LanguagePicker.vue'
import { allowsAuto, AUTO_CODE, AUTO_LANG, coercePair, LANGS, langName, pickLang, srcLabel, supportedOf, swapLangs } from '@/shared/languages'
import { isCancelled, MSG_MODEL_NOTICE, readPair, swapTexts, translateErrorMessage, unrecognizedTip, writePair } from './logic'
import { useModelWarmup } from './useModelWarmup'

/** 本工具 id（与 registry 一致） */
const TOOL_ID = 'translate'
/** 工具声明的可选模型（给选择器用） */
const models = findTool(TOOL_ID)?.models ?? []
/** 路由器：无可用模型时跳 AI 中心 */
const router = useRouter()

/** 点「无可用模型，去查看」：去 AI 中心 */
function goAiCenter(): void {
  void router.push(AI_CENTER_PATH)
}

/** 输入文字 */
const input = ref('')
/** 源/目标语言（从本地偏好恢复） */
const pair = ref(readPair())
/** 译文 */
const result = ref('')
/** 最近一次翻译识别出的源语言码（auto 时用于显示与交换） */
const detected = ref<string[]>([])
/** 红色小字提示（部分字符无法识别），空串表示不显示 */
const warnMsg = ref('')
/** 失败提示（人话），空串表示没有 */
const errMsg = ref('')
/** 正在翻译或转交 */
const busy = ref(false)
/** 当前翻译的取消控制器 */
let controller: AbortController | null = null
/** 翻译序号：丢弃已被取消或过期的结果 */
let seq = 0

/** 当前选中的模型选项 */
const { choice } = useModelChoice(TOOL_ID)
/** 模型状态源（只读） */
const store = useModelsStore()
/** 本地模型是否已安装 */
const modelReady = computed(() => !!store.get(NLLB_MODEL_ID)?.installed)
/** 能否触发：有文字，且本地模式下模型已就绪（翻译中始终可点以取消） */
const canGo = computed(() => busy.value || (!!input.value.trim() && modelReady.value && !tooFewLangs.value))
/** 主按钮文案 */
const goText = computed(() => (busy.value ? '取消翻译' : '翻译'))

/** 当前模型选项（按 choice 在 registry 声明里找） */
const option = computed(() => models.find((m) => m.modelId === choice.value))
/** 当前模型支持的语言码 */
const supported = computed(() => supportedOf(option.value))
/** 当前模型是否支持源语言自动检测 */
const autoOk = computed(() => allowsAuto(option.value))
/** 源语言选择器的候选目录：支持 auto 时 auto 排最前；目标选择器仍用 LANGS */
const srcLangs = computed(() => (autoOk.value ? [AUTO_LANG, ...LANGS] : LANGS))
/** 源语言选择器的可选码：支持集合 + auto（若支持） */
const srcSupported = computed(() => (autoOk.value ? [AUTO_CODE, ...supported.value] : supported.value))
/** 源语言行显示名（auto 且识别出语言时带括号） */
const srcName = computed(() => srcLabel(pair.value.src, detected.value))
/** 当前模型支持的语言少于 2 种：没法互译，禁用翻译 */
const tooFewLangs = computed(() => supported.value.length < 2)

/** 用当前模型支持的语言纠正语言对（不变则不触发写回） */
function fixPair(): void {
  const next = coercePair(pair.value, supported.value, autoOk.value)
  if (next.src !== pair.value.src || next.tgt !== pair.value.tgt) pair.value = next
}
fixPair()
watch([supported, autoOk], fixPair)
watch(pair, (v) => writePair(v))
onBeforeUnmount(() => controller?.abort())
// 进入预热；离开（停用或卸载）时取消进行中的翻译并卸载模型回收内存
useModelWarmup(modelReady)
// 输入改了：之前识别出的语言与「无法识别」提示都作废
watch(input, () => {
  detected.value = []
  warnMsg.value = ''
})
onDeactivated(cancel)

/** 取消进行中的翻译（若有） */
function cancel(): void {
  seq++
  controller?.abort()
  controller = null
  busy.value = false
}

/** 主按钮：翻译中则取消，否则开始翻译 */
function go(): void {
  if (busy.value) return cancel()
  void translate()
}

/** 用本地模型翻译 */
async function translate(): Promise<void> {
  const text = input.value.trim()
  if (!text) return
  const my = ++seq
  controller = new AbortController()
  busy.value = true
  errMsg.value = ''
  result.value = ''
  warnMsg.value = ''
  detected.value = []
  try {
    const r = await aiTranslate({ text, src: pair.value.src, tgt: pair.value.tgt }, controller.signal)
    if (my === seq) {
      result.value = r.text
      detected.value = r.detectedSrc ?? []
      warnMsg.value = unrecognizedTip(r.unrecognized)
    }
  } catch (e) {
    if (my === seq && !isCancelled(e)) errMsg.value = translateErrorMessage(e)
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
  detected.value = []
}

/** 清空输入和输出：取消进行中的翻译，清掉输入、译文、错误提示和「没人接手」的备选入口 */
function clearAll(): void {
  cancel()
  input.value = ''
  result.value = ''
  errMsg.value = ''
  warnMsg.value = ''
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
    <van-notice-bar v-if="!modelReady" mode="link" wrapable :scrollable="false" left-icon="info-o" @click="goAiCenter">{{ MSG_MODEL_NOTICE }}</van-notice-bar>

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
      <button type="button" class="tr-copy" aria-label="清空输入和输出" :disabled="!input && !result && !errMsg" @click="clearAll">
        <van-icon name="delete-o" />
        <span>清空</span>
      </button>
    </div>
    <div class="tool-card">
      <van-field v-model="input" type="textarea" rows="4" autosize placeholder="粘贴或输入要翻译的文字" :maxlength="TEXT_MAX" show-word-limit />
      <van-button class="tr-go" type="primary" block round :disabled="!canGo" @click="go">{{ goText }}</van-button>
    </div>

    <!-- 中：左边模型选择，右边交换（无修饰的按钮），整体缩小 1/3 -->
    <div class="tr-mid">
      <model-picker :tool-id="TOOL_ID" :models="models" />
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
      <button type="button" class="tr-copy" aria-label="复制译文" :disabled="!result" @click="copy(result)">
        <van-icon name="records-o" />
        <span>复制</span>
      </button>
    </div>
    <div class="tool-card">
      <div class="tr-out" dir="auto">
        <van-loading v-if="busy" size="20px">翻译中，请稍候…</van-loading>
        <p v-else-if="errMsg" class="tr-out__err">{{ errMsg }}</p>
        <template v-else-if="result">
          <p class="tr-out__text">{{ result }}</p>
          <p v-if="warnMsg" class="tr-out__warn">{{ warnMsg }}</p>
        </template>
        <p v-else class="tr-out__empty">译文会显示在这里</p>
      </div>
    </div>
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

.tr-go {
  margin-top: $space-3;
}

// 中段：模型选择（默认 AI 图标按钮）在左，交换按钮靠右
// 中段：一行，左模型选择、右交换；按钮整体缩小 1/3（zoom 同时缩小点击区）
.tr-mid {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 $space-2;
}

.tr-mid :deep(.van-button),
.tr-swap {
  zoom: 0.667;
}

// 模型选择器的触发按钮宽度加倍（缩放前 40px → 80px）
.tr-mid :deep(.van-button) {
  width: 80px;
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
  min-height: 96px;
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
