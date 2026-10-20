<script setup lang="ts">
// logo 设计：输入品牌名 → 智能排版出 6 个方案 → 点选一个进入微调（模板/配色/图标/字体/字号）→ 存 PNG 或分享。
// 排版靠“模板 + 图标 + 字体 + 配色”的自研渲染，本地 Qwen 只负责把一句话需求挑成方案参数；没模型或失败时用关键词规则兜底。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import BottomActions from '@/shared/BottomActions.vue'
import ColorPicker from '@/shared/ColorPicker.vue'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import ModelPicker from '@/shared/ModelPicker.vue'
import { canvasToBlob, createCanvas, releaseCanvas, saveBlob, writeBlobToCache } from '@/shared/image-io'
import { AiNotReadyError, aiInvoke, isAiCancelled } from '@/native/ai'
import { AI_METHODS } from '@/native/aiMethods'
import { share } from '@/native/system'
import { useAiCatalog } from '@/native/useAiCatalog'
import { ICON_DATA, type IconGroup } from './assets/iconData'
import { FONTS } from './fonts'
import { DESC_MAX, NAME_MAX, SLOGAN_MAX, canGenerate, clampFontScale, clampSpacing, outputName, paramsFromPlan, searchIcons, syncInput } from './logic'
import { GROUP_NAMES, generatePlans, planByKeywords, type LogoPlan } from './plan'
import { PALETTES, applyOverrides, getPalette } from './palettes'
import { drawLogoToCanvas, renderLogoSvg } from './render'
import { TEMPLATES } from './scene'
import { FONT_SCALE_MAX, FONT_SCALE_MIN, SPACING_MAX, SPACING_MIN, type LogoParams } from './types'

/** 本工具 id（与 registry 一致） */
const TOOL_ID = 'logo'
/** 大模型提供者 */
const PROVIDER_QWEN = 'local-qwen'
/** 排版用的采样温度：要多样但不能乱 */
const QWEN_TEMPERATURE = 0.6
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
/** 提示文案：缺品牌名 */
const MSG_NAME = '先写个品牌名'
/** 图标分组 id 列表（用于分组筛选按钮） */
const GROUP_IDS = Object.keys(GROUP_NAMES) as IconGroup[]

/** 本工具的 AI 目录 */
const catalog = useAiCatalog(TOOL_ID)
/** 本地大模型是否就绪 */
const qwenReady = computed(() => catalog.items.value.find((i) => i.providerId === PROVIDER_QWEN)?.status === 'ready')
/** 探测完且没有可用模型时给个提示条（只提示，不影响用规则排版） */
const showNotice = computed(() => catalog.ready.value && !qwenReady.value)

/** 品牌名 */
const name = ref('')
/** 标语 */
const slogan = ref('')
/** 一句话描述 */
const desc = ref('')
/** 6 个方案（已转成完整参数） */
const plans = ref<LogoParams[]>([])
/** 选中的方案下标，-1 为没选 */
const picked = ref(-1)
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
/** 编辑区的预览 SVG */
const previewSvg = computed(() => (params.value ? renderLogoSvg(params.value) : ''))
/** 方案缩略图 SVG */
const planSvgs = computed(() => plans.value.map((p) => renderLogoSvg(p)))
/** 配色色块背景（含主色），避免模板里重复调用 applyOverrides */
const swatches = PALETTES.map((c) => applyOverrides(c))

/** 调 Qwen 跑一次提示词，返回原文 */
async function runQwen(prompt: string): Promise<string> {
  const r = await aiInvoke('prompt', { text: prompt }, { provider: PROVIDER_QWEN, entry: AI_METHODS.run, options: { preset: 'prompt', temperature: QWEN_TEMPERATURE }, signal: abort?.signal })
  return r.text ?? ''
}

/** 把方案列表落到页面状态（保留用户已改的品牌名等输入） */
function applyPlans(list: LogoPlan[], note: string): void {
  plans.value = list.map((p) => paramsFromPlan(p, input.value))
  picked.value = -1
  params.value = null
  meta.value = note
}

/** 点主按钮：忙时取消；否则生成 6 个方案（模型就绪走模型，否则规则；模型失败也回规则） */
async function onGenerate(): Promise<void> {
  if (busy.value) {
    abort?.abort()
    busy.value = false
    return
  }
  if (!canGenerate(name.value)) {
    showToast(MSG_NAME)
    return
  }
  abort = new AbortController()
  busy.value = true
  const seq = ++runSeq
  try {
    if (!qwenReady.value) {
      applyPlans(planByKeywords(input.value), MSG_RULES)
    } else {
      const r = await generatePlans(input.value, runQwen)
      applyPlans(r.plans, r.source === 'rules' ? MSG_FALLBACK : '')
    }
  } catch (e) {
    if (isAiCancelled(e)) return
    if (e instanceof AiNotReadyError) {
      applyPlans(planByKeywords(input.value), MSG_RULES)
      void catalog.refresh()
    } else {
      showFailToast((e as { message?: string } | null)?.message || '出错了，请重试')
    }
  } finally {
    if (seq === runSeq) {
      busy.value = false
      abort = null
    }
  }
}

/** 点选一个方案进入微调 */
function pick(i: number): void {
  picked.value = i
  params.value = { ...plans.value[i] }
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
const mainText = computed(() => (busy.value ? '取消' : plans.value.length ? '重新排版' : '生成方案'))
onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <div class="tool-page">
    <model-missing-notice v-if="showNotice" />

    <tool-group title="品牌信息">
      <van-field v-model="name" label="品牌名" placeholder="必填，如：山屿咖啡" :maxlength="NAME_MAX" clearable />
      <van-field v-model="slogan" label="标语" placeholder="选填，如：慢生活 好时光" :maxlength="SLOGAN_MAX" clearable />
      <van-field v-model="desc" label="一句话描述" placeholder="选填，如：安静的社区手冲咖啡店" :maxlength="DESC_MAX" clearable />
      <p class="tool-hint">智能排版：按你的描述挑模板、配色和图标，一次给 6 个方案，挑一个再微调。</p>
    </tool-group>

    <tool-group v-if="plans.length" title="方案（点一个来微调）">
      <p v-if="meta" class="tool-hint">{{ meta }}</p>
      <div class="lg-grid">
        <button v-for="(svg, i) in planSvgs" :key="i" type="button" class="lg-card" :class="{ 'lg-card--on': i === picked }" :aria-label="`方案 ${i + 1}`" @click="pick(i)">
          <span class="lg-card__img" v-html="svg" />
        </button>
      </div>
    </tool-group>

    <template v-if="params">
      <tool-group title="预览">
        <div class="lg-preview" v-html="previewSvg" />
      </tool-group>

      <tool-group title="版式">
        <div class="lg-chips">
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

      <tool-group title="图标">
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

    <bottom-actions :actions="{ save: { disabled: !params }, share: { disabled: !params } }" ai main :main-text="mainText" :main-type="busy ? 'danger' : 'primary'" @main="onGenerate" @save="save" @share="shareLogo">
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
