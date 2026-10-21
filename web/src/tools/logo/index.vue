<script setup lang="ts">
// logo 设计：输入品牌名 → 智能排版出 6 个模板方案；装了本地 SDXS 模型时，再按 4 个概念物体依次生成 AI 符号（一张出一张、可取消）→ 点选一个进入微调 → 存 PNG 或分享。
// 排版靠“模板 + 图标 + 字体 + 配色”的自研渲染；AI 符号放进 App 自己画的容器。本地 Qwen 只在词表认不出行业时推荐概念词，或挑方案参数；没模型或失败时用词表/关键词规则兜底。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import BottomActions from '@/shared/BottomActions.vue'
import ColorPicker from '@/shared/ColorPicker.vue'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import ModelPicker from '@/shared/ModelPicker.vue'
import { canvasToBlob, createCanvas, releaseCanvas, saveBlob, writeBlobToCache } from '@/shared/image-io'
import { AiNotReadyError, aiInvoke, aiUnload, isAiCancelled } from '@/native/ai'
import { AI_METHODS } from '@/native/aiMethods'
import { share } from '@/native/system'
import { useAiCatalog } from '@/native/useAiCatalog'
import { ICON_DATA, type IconGroup } from './assets/iconData'
import { CONCEPT_COUNT, conceptPrompt, conceptsFromText, describeConcepts, resolveConcepts } from './concepts'
import { FONTS } from './fonts'
import { DESC_MAX, NAME_MAX, SLOGAN_MAX, canGenerate, clampFontScale, clampSpacing, outputName, paramsFromPlan, searchIcons, syncInput } from './logic'
import { GROUP_NAMES, generatePlans, planByKeywords, type LogoPlan } from './plan'
import { PALETTES, applyOverrides, getPalette } from './palettes'
import { drawLogoToCanvas, renderLogoSvg } from './render'
import { TEMPLATES } from './scene'
import { GATE_WARN_TEXT, paramsFromSymbol, progressText, reasonText, runSymbolBatch, sortCandidates, needTemplateFallback, type SymbolCandidate } from './symbol'
import { SYMBOL_LAYOUTS } from './symbolScene'
import { FONT_SCALE_MAX, FONT_SCALE_MIN, SPACING_MAX, SPACING_MIN, type LogoParams } from './types'

/** 本工具 id（与 registry 一致） */
const TOOL_ID = 'logo'
/** 大模型提供者 */
const PROVIDER_QWEN = 'local-qwen'
/** logo 符号生成提供者（本地 SDXS） */
const PROVIDER_LOGO = 'local-logo-sdxs'
/** 排版用的采样温度：要多样但不能乱 */
const QWEN_TEMPERATURE = 0.6
/** 推荐概念词用的采样温度：要稳，格式比花样重要 */
const QWEN_CONCEPT_TEMPERATURE = 0.3
/** 滑杆步长：字号倍率 */
const SCALE_STEP = 0.05
/** 滑杆步长：字距 */
const SPACING_STEP = 0.01
/** 导出 PNG 的 MIME */
const MIME_PNG = 'image/png'
/** 提示文案：没有可用模型 */
const MSG_RULES = '没有可用的本地模型，已用关键词规则排版'
/** 提示文案：模型没给出合格结果 */
const MSG_FALLBACK = '模型这次没给出合格的方案，已改用关键词规则排版'
/** 提示文案：正在取消（原生一步前向不能中途打断，要等这一段跑完） */
const MSG_CANCELLING = '正在取消，等当前这张收尾…'
/** 提示文案：被取消 */
const MSG_CANCELLED = '已取消，已出的图形保留'
/** 提示文案：上一张还在收尾 */
const MSG_WAIT_PREV = '上一次的生成还在收尾，稍等一下…'
/** 提示文案：AI 图形出错 */
const MSG_AI_FAIL = 'AI 图形没生成成功，已保留模板方案'
/** 提示文案：没有出 AI 图形（取消或出错）时补模板 */
const MSG_NO_AI = '没有出 AI 图形，已补上模板方案'
/** 提示文案：全部没过闸 */
const MSG_ALL_GATED = 'AI 图形都不太理想，已补上模板方案'
/** 提示文案：缺品牌名 */
const MSG_NAME = '先写个品牌名'
/** 图标分组 id 列表（用于分组筛选按钮） */
const GROUP_IDS = Object.keys(GROUP_NAMES) as IconGroup[]

/** 没有关键词方案时的兜底配色与字体 */
const FALLBACK_PLAN: LogoPlan = { template: 'stack', palette: PALETTES[0].id, icon: '', font: FONTS[0].id }
/** 本工具的 AI 目录 */
const catalog = useAiCatalog(TOOL_ID)
/** 本地大模型是否就绪 */
const qwenReady = computed(() => catalog.items.value.find((i) => i.providerId === PROVIDER_QWEN)?.status === 'ready')
/** 本地 SDXS 是否就绪（AI 图形可用） */
const logoReady = computed(() => catalog.items.value.find((i) => i.providerId === PROVIDER_LOGO)?.status === 'ready')
/** 探测完且没有 AI 图形模型时给个提示条（只提示，页面照常用模板排版） */
const showNotice = computed(() => catalog.ready.value && !logoReady.value)

/** 品牌名 */
const name = ref('')
/** 标语 */
const slogan = ref('')
/** 一句话描述 */
const desc = ref('')
/** 6 个方案（已转成完整参数） */
const plans = ref<LogoParams[]>([])
/** 选中的方案：`tpl:下标`（模板方案）/ `ai:序号`（AI 图形），空为没选 */
const picked = ref('')
/** 正在微调的参数 */
const params = ref<LogoParams | null>(null)
/** 方案来源说明，空则不显示 */
const meta = ref('')
/** 是否在生成中 */
const busy = ref(false)
/** 取消控制器 */
let abort: AbortController | null = null
/** 第几次生成：取消后旧任务的收尾不能冲掉新任务 */
let runSeq = 0
/** 4 个概念物体词（英文，可改） */
const concepts = ref<string[]>([])
/** 概念来源说明，空则不显示 */
const conceptNote = ref('')
/** 用户是否手改过概念：改过就不再按输入自动推荐 */
const conceptsManual = ref(false)
/** 已出的 AI 候选（按生成顺序） */
const candidates = ref<SymbolCandidate[]>([])
/** AI 部分的进度或状态文案，空则不显示 */
const aiStatus = ref('')
/** AI 流程是否已跑完（含取消、出错）：跑完后才按闸门重排并决定要不要补模板 */
const aiDone = ref(false)
/** 是否展开模板方案（AI 有过闸结果时默认折叠） */
const tplOpen = ref(false)
/** 页面是否可能已把 SDXS 载入内存（离开页面与用 Qwen 前要让位） */
let logoLoaded = false
/** 图标搜索词 */
const iconQuery = ref('')
/** 图标分组筛选，空为全部 */
const iconGroup = ref<IconGroup | ''>('')

/** 当前输入 */
const input = computed(() => ({ name: name.value, slogan: slogan.value, desc: desc.value }))
/** 图标候选 */
const iconList = computed(() => searchIcons(iconQuery.value, iconGroup.value))
/** 自定义主色：读写 primaryOverride，未设置时显示配色自身主色 */
const primary = computed({
  get: () => params.value?.primaryOverride ?? getPalette(params.value?.palette ?? '').primary,
  set: (v: string) => {
    if (params.value) params.value = { ...params.value, primaryOverride: v }
  },
})
/** 概念推荐用的文本：品牌名 + 标语 + 描述 */
const conceptText = computed(() => `${name.value} ${slogan.value} ${desc.value}`.trim())
/** 输入变了且用户没手改：按词表即时推荐（词表认不出的留空，等点生成时再问 Qwen 或走通用） */
watch(conceptText, (t) => {
  if (conceptsManual.value || busy.value) return
  const r = conceptsFromText(t)
  concepts.value = r ? r.objects : []
  conceptNote.value = r ? describeConcepts(r) : ''
}, { immediate: true })
/** 用户手改概念 */
function onConceptInput(i: number, v: string): void {
  const next = concepts.value.slice()
  while (next.length < CONCEPT_COUNT) next.push('')
  next[i] = v
  concepts.value = next
  conceptsManual.value = true
  conceptNote.value = '已按你写的来'
}
/** 恢复按描述自动推荐 */
function resetConcepts(): void {
  conceptsManual.value = false
  const r = conceptsFromText(conceptText.value)
  concepts.value = r ? r.objects : []
  conceptNote.value = r ? describeConcepts(r) : ''
}

/** AI 卡片：候选 + 完整参数；跑完后过闸的排前面（稳定） */
const aiCards = computed(() => {
  const base = plans.value
  const all = candidates.value.map((c, i) => ({ c, i, params: paramsFromSymbol(c, base[i % Math.max(1, base.length)] ?? FALLBACK_PLAN, input.value, i) }))
  if (!aiDone.value) return all
  const order = sortCandidates(candidates.value)
  return order.map((c) => all[candidates.value.indexOf(c)])
})
/** AI 卡片缩略图 SVG */
const aiSvgs = computed(() => aiCards.value.map((x) => renderLogoSvg(x.params)))
/** 模板方案是否显示：没有 AI 模型时恒显示；有 AI 时跑完后若一张过闸的都没有则自动显示，否则用户点开才显示 */
const tplVisible = computed(() => !logoReady.value || tplOpen.value || (aiDone.value && needTemplateFallback(candidates.value)))
/** 编辑区的预览 SVG */
const previewSvg = computed(() => (params.value ? renderLogoSvg(params.value) : ''))
/** 方案缩略图 SVG */
const planSvgs = computed(() => plans.value.map((p) => renderLogoSvg(p)))
/** 配色色块背景（含主色），避免模板里重复调用 applyOverrides */
const swatches = PALETTES.map((c) => applyOverrides(c))

/** 调 Qwen 跑一次提示词，返回原文；temperature 缺省用排版的采样温度 */
async function runQwen(prompt: string, temperature = QWEN_TEMPERATURE): Promise<string> {
  const r = await aiInvoke('prompt', { text: prompt }, { provider: PROVIDER_QWEN, entry: AI_METHODS.run, options: { preset: 'prompt', temperature }, signal: abort?.signal })
  return r.text ?? ''
}

/** 把方案列表落到页面状态（保留用户已改的品牌名等输入） */
function applyPlans(list: LogoPlan[], note: string): void {
  plans.value = list.map((p) => paramsFromPlan(p, input.value))
  picked.value = ''
  params.value = null
  meta.value = note
}

/** 让 SDXS 让出内存：Qwen 与 SDXS 同时常驻会超出内存安全线（原生只在“加载 SDXS 时卸其它”，反方向要页面自己避开） */
async function releaseLogoModel(): Promise<void> {
  if (!logoLoaded) return
  logoLoaded = false
  try {
    await aiUnload(PROVIDER_LOGO)
  } catch {
    /* 卸载失败不影响后续（原生回收策略兜底） */
  }
}

/** 解析要用的 4 个概念：用户手改过就用手改的；否则词表 → Qwen（就绪时）→ 通用词 */
async function resolveList(): Promise<string[]> {
  const typed = concepts.value.map((c) => c.trim()).filter(Boolean)
  if (conceptsManual.value && typed.length) return typed.slice(0, CONCEPT_COUNT)
  const run = qwenReady.value
    ? async (prompt: string): Promise<string> => {
        await releaseLogoModel()
        return runQwen(prompt, QWEN_CONCEPT_TEMPERATURE)
      }
    : null
  const r = await resolveConcepts(conceptText.value, run)
  concepts.value = r.objects
  conceptNote.value = describeConcepts(r)
  return r.objects
}

/** 跑 AI 图形：逐张生成并上屏；返回是否被取消 */
async function runAi(seq: number): Promise<boolean> {
  aiStatus.value = '正在想要画哪几样东西…'
  const list = await resolveList()
  if (seq !== runSeq) return true
  const t0 = Date.now()
  const r = await runSymbolBatch(
    list,
    async (concept, seed, signal) => {
      logoLoaded = true
      return aiInvoke('logoSymbol', { prompt: conceptPrompt(concept), seed }, { provider: PROVIDER_LOGO, entry: AI_METHODS.logoSymbol, signal })
    },
    {
      signal: abort?.signal,
      onProgress: (done, total) => {
        if (seq === runSeq) aiStatus.value = `${progressText(done, total)}，每张约 10 秒`
      },
      onBusy: () => {
        if (seq === runSeq) aiStatus.value = MSG_WAIT_PREV
      },
      onItem: (c) => {
        if (seq === runSeq && c) candidates.value = [...candidates.value, c]
      },
    },
  )
  if (seq !== runSeq) return true
  const sec = Math.round((Date.now() - t0) / 1000)
  if (r.cancelled) {
    aiStatus.value = MSG_CANCELLED
  } else if (r.error) {
    aiStatus.value = ''
    if (r.error instanceof AiNotReadyError) void catalog.refresh()
    showFailToast((r.error as { message?: string } | null)?.message || MSG_AI_FAIL)
  } else {
    aiStatus.value = `共 ${r.items.length} 张，用时约 ${sec} 秒`
  }
  return r.cancelled
}

/** 点主按钮：忙时取消；否则生成。有 AI 图形模型：模板方案用关键词规则即出，再逐张出 AI 图形；没有：模型就绪走 Qwen 排版，否则规则 */
async function onGenerate(): Promise<void> {
  if (busy.value) {
    abort?.abort()
    busy.value = false
    aiDone.value = true
    if (aiStatus.value) aiStatus.value = MSG_CANCELLING
    return
  }
  if (!canGenerate(name.value)) {
    showToast(MSG_NAME)
    return
  }
  abort = new AbortController()
  busy.value = true
  const seq = ++runSeq
  const withAi = logoReady.value
  candidates.value = []
  aiStatus.value = ''
  aiDone.value = !withAi
  tplOpen.value = false
  picked.value = ''
  params.value = null
  try {
    if (withAi) {
      applyPlans(planByKeywords(input.value), '')
      const cancelled = await runAi(seq)
      if (!cancelled && seq === runSeq && needTemplateFallback(candidates.value)) showToast(MSG_ALL_GATED)
    } else if (!qwenReady.value) {
      applyPlans(planByKeywords(input.value), MSG_RULES)
    } else {
      const r = await generatePlans(input.value, runQwen)
      applyPlans(r.plans, r.source === 'rules' ? MSG_FALLBACK : '')
    }
  } catch (e) {
    if (isAiCancelled(e)) return
    if (e instanceof AiNotReadyError) {
      if (!plans.value.length) applyPlans(planByKeywords(input.value), MSG_RULES)
      void catalog.refresh()
    } else {
      showFailToast((e as { message?: string } | null)?.message || '出错了，请重试')
    }
  } finally {
    if (seq === runSeq) {
      busy.value = false
      abort = null
      aiDone.value = true
    }
  }
}

/** 点选一个模板方案进入微调 */
function pickPlan(i: number): void {
  picked.value = `tpl:${i}`
  params.value = { ...plans.value[i] }
}

/** 点选一个 AI 图形进入微调 */
function pickAi(i: number): void {
  picked.value = `ai:${aiCards.value[i].i}`
  params.value = { ...aiCards.value[i].params }
}

/** AI 图形改用模板图标：去掉 symbol，图标取当前第一个关键词方案的 */
function useTemplateIcon(): void {
  patch({ symbol: undefined, icon: plans.value[0]?.icon ?? '' })
}

/** 换 AI 符号的版式 */
function pickSymbolLayout(layout: (typeof SYMBOL_LAYOUTS)[number]['id']): void {
  if (params.value?.symbol) patch({ symbol: { ...params.value.symbol, layout } })
}

/** 改一项参数（整体替换，触发预览重画） */
function patch(part: Partial<LogoParams>): void {
  if (params.value) params.value = { ...params.value, ...part }
}

/** 换配色时清掉自定义主色，免得盖住新配色 */
function pickPalette(id: string): void {
  patch({ palette: id, primaryOverride: undefined })
}

/** 品牌名、标语改动后同步到方案缩略图与编辑参数 */
watch([name, slogan], () => {
  if (plans.value.length) plans.value = plans.value.map((p) => syncInput(p, input.value))
  if (params.value) params.value = syncInput(params.value, input.value)
})

/** 把当前 logo 画成 PNG blob */
async function toBlob(): Promise<Blob | null> {
  if (!params.value) return null
  const canvas = createCanvas(1, 1)
  try {
    drawLogoToCanvas(canvas, params.value)
    return await canvasToBlob(canvas, MIME_PNG)
  } finally {
    releaseCanvas(canvas)
  }
}

/** 保存 PNG */
async function save(): Promise<void> {
  try {
    const blob = await toBlob()
    if (!blob) return
    const res = await saveBlob(blob, outputName(name.value))
    showSuccessToast(res.mode === 'native' ? '已保存到相册' : '已开始下载')
  } catch {
    showFailToast('保存失败，请重试')
  }
}

/** 分享 PNG：先写进缓存，再交给系统分享面板 */
async function shareLogo(): Promise<void> {
  try {
    const blob = await toBlob()
    if (!blob) return
    const fileName = outputName(name.value)
    const path = await writeBlobToCache(blob, fileName)
    if (!(await share({ path, mime: MIME_PNG, title: fileName }))) showToast('没能打开分享面板')
  } catch (e) {
    showToast((e as { message?: string } | null)?.message ?? '分享失败')
  }
}

/** 主按钮文案 */
const mainText = computed(() => (busy.value ? '取消' : plans.value.length ? '重新生成' : '生成方案'))
onBeforeUnmount(() => {
  abort?.abort()
  void releaseLogoModel()
})
</script>

<template>
  <div class="tool-page">
    <model-missing-notice v-if="showNotice" />

    <tool-group title="品牌信息">
      <van-field v-model="name" label="品牌名" placeholder="必填，如：山屿咖啡" :maxlength="NAME_MAX" clearable />
      <van-field v-model="slogan" label="标语" placeholder="选填，如：慢生活 好时光" :maxlength="SLOGAN_MAX" clearable />
      <van-field v-model="desc" label="一句话描述" placeholder="选填，如：安静的社区手冲咖啡店" :maxlength="DESC_MAX" clearable />
      <p class="tool-hint">智能排版：按你的描述挑模板、配色和图标，一次给 6 个模板方案；装了本地 AI 图形模型时，还会再生成 4 个 AI 图形，挑一个再微调。</p>
    </tool-group>

    <tool-group v-if="logoReady" title="AI 图形（本地 AI 生成，仅供参考）">
      <van-notice-bar wrapable :scrollable="false" left-icon="warning-o">图形由本机 AI 模型生成，仅供参考；用于商业前请自行检索商标，避免与已有标识雷同。</van-notice-bar>
      <p class="tool-hint">要画的 4 样东西（英文，可以改）{{ conceptNote ? `：${conceptNote}` : '' }}。词表认不出行业时，点生成后会请本地模型推荐。</p>
      <van-field v-for="i in CONCEPT_COUNT" :key="i" :model-value="concepts[i - 1] ?? ''" :label="`图形 ${i}`" placeholder="如：a coffee cup" :disabled="busy" clearable @update:model-value="onConceptInput(i - 1, $event)" />
      <div v-if="conceptsManual" class="lg-chips">
        <van-button size="mini" plain :disabled="busy" @click="resetConcepts">恢复自动推荐</van-button>
      </div>
      <p v-if="aiStatus" class="tool-hint"><van-loading v-if="busy" size="14" class="lg-spin" />{{ aiStatus }}</p>
      <div v-if="aiCards.length" class="lg-grid">
        <button v-for="(svg, i) in aiSvgs" :key="aiCards[i].i" type="button" class="lg-card" :class="{ 'lg-card--on': picked === `ai:${aiCards[i].i}` }" :aria-label="`AI 图形 ${i + 1}`" @click="pickAi(i)">
          <span class="lg-card__img" v-html="svg" />
          <span v-if="!aiCards[i].c.gateOk" class="lg-card__warn">{{ GATE_WARN_TEXT }}{{ reasonText(aiCards[i].c.reasons) ? `（${reasonText(aiCards[i].c.reasons)}）` : '' }}</span>
        </button>
      </div>
      <p v-else-if="aiDone && !busy && plans.length" class="tool-hint">这次没有出图。</p>
    </tool-group>

    <div v-if="plans.length && logoReady && !tplVisible && !busy" class="lg-more">
      <van-button size="small" plain @click="tplOpen = true">查看模板图标方案（6 个）</van-button>
    </div>

    <tool-group v-if="plans.length && tplVisible" :title="logoReady ? '模板图标方案（点一个来微调）' : '方案（点一个来微调）'">
      <p v-if="meta" class="tool-hint">{{ meta }}</p>
      <p v-if="logoReady && aiDone && needTemplateFallback(candidates)" class="tool-hint">{{ candidates.length ? MSG_ALL_GATED : MSG_NO_AI }}。</p>
      <div class="lg-grid">
        <button v-for="(svg, i) in planSvgs" :key="i" type="button" class="lg-card" :class="{ 'lg-card--on': picked === `tpl:${i}` }" :aria-label="`方案 ${i + 1}`" @click="pickPlan(i)">
          <span class="lg-card__img" v-html="svg" />
        </button>
      </div>
    </tool-group>

    <template v-if="params">
      <tool-group title="预览">
        <div class="lg-preview" v-html="previewSvg" />
      </tool-group>

      <tool-group title="版式">
        <div v-if="params.symbol" class="lg-chips">
          <van-button v-for="l in SYMBOL_LAYOUTS" :key="l.id" size="small" :type="params.symbol.layout === l.id ? 'primary' : 'default'" :plain="params.symbol.layout !== l.id" @click="pickSymbolLayout(l.id)">{{ l.name }}</van-button>
          <van-button size="small" plain @click="useTemplateIcon">改用模板图标</van-button>
        </div>
        <div v-else class="lg-chips">
          <van-button v-for="t in TEMPLATES" :key="t.id" size="small" :type="params.template === t.id ? 'primary' : 'default'" :plain="params.template !== t.id" @click="patch({ template: t.id })">{{ t.name }}</van-button>
        </div>
      </tool-group>

      <tool-group title="配色">
        <div class="lg-swatches">
          <button v-for="(c, i) in swatches" :key="PALETTES[i].id" type="button" class="lg-swatch" :class="{ 'lg-swatch--on': params.palette === PALETTES[i].id }" :aria-label="PALETTES[i].name" :style="{ background: c.bg, borderColor: c.primary }" @click="pickPalette(PALETTES[i].id)">
            <i :style="{ background: c.primary }" />
            <i :style="{ background: c.secondary }" />
          </button>
        </div>
        <van-cell title="自定义主色" center>
          <template #value>
            <color-picker v-model="primary" label="主色" />
          </template>
        </van-cell>
        <van-cell title="反色" center>
          <template #value>
            <van-switch :model-value="params.invert" size="20" @update:model-value="patch({ invert: $event })" />
          </template>
        </van-cell>
      </tool-group>

      <tool-group v-if="!params.symbol" title="图标">
        <van-search v-model="iconQuery" placeholder="搜图标，如：咖啡、火箭、宠物" shape="round" />
        <div class="lg-chips">
          <van-button size="mini" :type="iconGroup === '' ? 'primary' : 'default'" :plain="iconGroup !== ''" @click="iconGroup = ''">全部</van-button>
          <van-button v-for="g in GROUP_IDS" :key="g" size="mini" :type="iconGroup === g ? 'primary' : 'default'" :plain="iconGroup !== g" @click="iconGroup = g">{{ GROUP_NAMES[g] }}</van-button>
        </div>
        <div class="lg-icons">
          <button type="button" class="lg-icon" :class="{ 'lg-icon--on': !params.icon }" aria-label="不要图标" @click="patch({ icon: '' })">无</button>
          <button v-for="k in iconList" :key="k" type="button" class="lg-icon" :class="{ 'lg-icon--on': params.icon === k }" :aria-label="ICON_DATA[k].k[0]" @click="patch({ icon: k })">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="ICON_DATA[k].d" /></svg>
          </button>
        </div>
        <p v-if="!iconList.length" class="tool-hint">没搜到，换个词试试。</p>
      </tool-group>

      <tool-group title="字体与字号">
        <div class="lg-chips">
          <van-button v-for="f in FONTS" :key="f.id" size="small" :type="params.font === f.id ? 'primary' : 'default'" :plain="params.font !== f.id" :style="{ fontFamily: f.family, fontWeight: f.weight }" @click="patch({ font: f.id })">{{ f.name }}</van-button>
        </div>
        <van-cell title="字号" center>
          <template #value>
            <van-slider :model-value="params.fontScale" :min="FONT_SCALE_MIN" :max="FONT_SCALE_MAX" :step="SCALE_STEP" class="lg-slider" @update:model-value="patch({ fontScale: clampFontScale($event) })" />
          </template>
        </van-cell>
        <van-cell title="字距" center>
          <template #value>
            <van-slider :model-value="params.spacing" :min="SPACING_MIN" :max="SPACING_MAX" :step="SPACING_STEP" class="lg-slider" @update:model-value="patch({ spacing: clampSpacing($event) })" />
          </template>
        </van-cell>
        <p class="tool-hint">文字用手机自带字体，不同手机上字形会略有差别；导出的 PNG 就是这台手机上看到的样子。</p>
      </tool-group>
    </template>

    <bottom-actions :main-loading="busy" :actions="{ save: { disabled: !params }, share: { disabled: !params } }" ai main :main-text="mainText" :main-type="busy ? 'danger' : 'primary'" @main="onGenerate" @save="save" @share="shareLogo">
      <template #ai>
        <model-picker :tool-id="TOOL_ID" variant="bar" />
      </template>
    </bottom-actions>
  </div>
</template>

<style lang="scss" scoped>
.lg-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: $space-2;
  padding: $space-2;
}
.lg-card {
  padding: 0;
  border: 2px solid transparent;
  border-radius: 8px;
  background: transparent;
  overflow: hidden;
  line-height: 0;
}
.lg-card__warn {
  display: block;
  padding: 4px 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--van-warning-color, #ed6a0c);
  text-align: left;
}
.lg-more {
  display: flex;
  justify-content: center;
  padding: $space-2;
}
.lg-spin {
  margin-right: 6px;
  vertical-align: -2px;
}
.lg-card--on {
  border-color: var(--van-primary-color);
}
.lg-card__img {
  display: block;
}
.lg-card__img :deep(svg),
.lg-preview :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 6px;
}
.lg-preview {
  padding: $space-2;
  line-height: 0;
}
.lg-chips {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  padding: $space-2;
}
.lg-swatches {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: $space-2;
  padding: $space-2;
}
.lg-swatch {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  aspect-ratio: 1 / 1;
  border: 2px solid;
  border-radius: 8px;
  padding: 0;
  opacity: 0.85;
}
.lg-swatch i {
  width: 36%;
  height: 36%;
  border-radius: 50%;
}
.lg-swatch--on {
  opacity: 1;
  outline: 2px solid var(--van-primary-color);
  outline-offset: 1px;
}
.lg-icons {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: $space-2;
  padding: $space-2;
}
.lg-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1 / 1;
  border: 1px solid var(--c-border, #ddd);
  border-radius: 8px;
  background: transparent;
  color: var(--c-text);
  font-size: 12px;
  padding: 6px;
}
.lg-icon svg {
  width: 100%;
  height: 100%;
}
.lg-icon--on {
  border-color: var(--van-primary-color);
  color: var(--van-primary-color);
  background: rgba(25, 137, 250, 0.08);
}
.lg-slider {
  width: 100%;
  margin: $space-2 0;
}
</style>
