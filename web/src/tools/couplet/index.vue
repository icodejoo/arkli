<script setup lang="ts">
// 对联：四种玩法。随机=从 73 万副语料里不重复地抽（原生按下标取，不读全量）；对下联=本地 GPT-2 按上联生成等长下联；
// 趣味问答（大模型）=本地 Qwen 按用户要求生成（可选横批、字数、类型，输出会校验，不合格重试一次）；
// 出上联=只出上联、人来对下联（来源可选语料或大模型，可选类型与字数），可看参考下联。
// 出来的对联可以微调，画成红底金字的竖排图并导出 PNG。模型与语料的状态只读（目录与 store），下载等都在 AI 中心。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useElementSize } from '@vueuse/core'
import { useRouter } from 'vue-router'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import BottomActions from '@/shared/BottomActions.vue'
import CellPicker from '@/shared/CellPicker.vue'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import ModelPicker from '@/shared/ModelPicker.vue'
import { copyText } from '@/shared/clipboard'
import { canvasToBlob, saveBlob } from '@/shared/image-io'
import { AI_CENTER_PATH, buildExtraItem, type PickerItem } from '@/shared/modelPicker'
import { AiNotReadyError, aiCouplet, aiInvoke, isAiCancelled } from '@/native/ai'
import { AI_METHODS } from '@/native/aiMethods'
import { corpusGet, corpusInfo, COUPLET_CORPUS_ID, type CorpusInfo, type CorpusPool } from '@/native/corpus'
import { useAiCatalog } from '@/native/useAiCatalog'
import { useModelsStore } from '@/stores/models'
import { loadCursor, nextDraw, saveCursor } from './cursor'
import { drawByLength } from './quiz'
import {
  BANNER_DEFAULT,
  BANNER_MAX,
  BANNER_MIN,
  CATEGORY_HINTS,
  DEFAULT_CATEGORY,
  MOURNING_CATEGORY,
  UPPER_LEN_ANY,
  UPPER_LENS,
  generateCouplet,
  generateUpper,
  validateUpper,
  type Couplet,
  type RunPrompt,
} from './generate'
import { loadCoupletFont, waitCoupletFont } from './font'
import { COUPLET_SPEC, customWarnings, drawCouplet, layoutCouplet } from './logic'

/** 本工具 id（与 registry 一致） */
const TOOL_ID = 'couplet'
/** 对下联用的提供者 */
const PROVIDER_COUPLET = 'local-couplet'
/** 大模型用的提供者 */
const PROVIDER_QWEN = 'local-qwen'
/** 导出文件名 */
const FILE_NAME = 'couplet.png'
/** 记住上次选的池（偏好，存取都 try/catch） */
const POOL_KEY = 'arkli.couplet.pool'
/** 模式名 */
type Mode = 'random' | 'lower' | 'llm' | 'quiz'
/** 出上联的来源 */
type QuizSource = 'corpus' | 'llm'
/** 出上联游标的池名前缀（与随机模式的游标分开，免得互相吃进度） */
const QUIZ_CURSOR_PREFIX = 'quiz:'
/** 动作项 key */
/** 大模型采样温度：写对联需要一点发散，又不能太散 */
const QWEN_TEMPERATURE = 0.7
/** 横批选项：不要横批 */
const BANNER_NONE = 0
/** 横批字数候选 */
const BANNER_LENS = Array.from({ length: BANNER_MAX - BANNER_MIN + 1 }, (_, i) => BANNER_MIN + i)
/** 横批选项：无 + 各字数 */
const BANNER_OPTIONS = [{ value: BANNER_NONE, label: '无' }, ...BANNER_LENS.map((n) => ({ value: n, label: `${n} 字` }))]
/** 上联字数选项：不限 + 各字数 */
const QUIZ_LEN_OPTIONS = [{ value: UPPER_LEN_ANY, label: '不限' }, ...UPPER_LENS.map((n) => ({ value: n, label: `${n} 字` }))]
/** 大模型类型选项 */
const CATEGORY_OPTIONS = CATEGORY_HINTS.map((c) => ({ value: c.name, label: c.name }))
/** 挽联池的显示名 */
const MOURNING_LABEL = '挽联（哀悼）'
/** 提示条文案 */
const MSG_CORPUS_MISSING = '随机模式需要对联语料库，请先下载'
const MSG_NOT_READY = '模型还没就绪，请先下载'
const MSG_REVIEW = '提示：0.8B 小模型会写出不工整甚至不通的句子，请自己把关'
const MSG_QUIZ_MISS = '没抽到这个字数的上联，换个字数或类型试试'
const MSG_RANDOM_NOTE = '横批与分类是系统推导的，仅供参考，不是原联自带'

/** 路由器：点提示条去 AI 中心 */
const router = useRouter()
/** 模型 store（只读） */
const store = useModelsStore()
/** 本工具的 AI 目录：含对联与文本两类提供者 */
const catalog = useAiCatalog(TOOL_ID)

/** 当前模式 */
const mode = ref<Mode>('random')
/** 当前这副（可手改） */
const result = ref<Couplet>({ up: '', down: '', banner: '' })
/** 当前结果是不是挽联（白底黑字、不贴福字）；对下联和手改沿用上次的判断 */
const mourning = ref(false)
/** 结果下面的小字：分类、剩余等 */
const meta = ref('')
/** 是否正在生成或抽取 */
const busy = ref(false)
/** 取消控制器（对下联、大模型可取消） */
let abort: AbortController | null = null

/** 语料库概况 */
const corpus = ref<CorpusInfo>({ ready: false })
/** 选中的池编号 */
const poolId = ref(0)
/** 对下联：上联输入 */
const upper = ref('')
/** 大模型：要求 */
const demand = ref('')
/** 大模型：横批选择，BANNER_NONE 为不要，否则是字数 */
const bannerChoice = ref(BANNER_DEFAULT)
/** 大模型：要不要横批 */
const wantBanner = computed(() => bannerChoice.value !== BANNER_NONE)
/** 大模型：横批字数（不要横批时随便给个默认值，生成逻辑不会用） */
const bannerLen = computed(() => bannerChoice.value || BANNER_DEFAULT)
/** 大模型：类型 */
const category = ref(DEFAULT_CATEGORY)
/** 出上联：来源 */
const quizSource = ref<QuizSource>('corpus')
/** AI 弹窗里的「语料库」行：出上联时与模型行并列，选它就用语料出题 */
const CORPUS_ROW_ID = 'couplet-corpus-source'
/** 出上联：字数，UPPER_LEN_ANY 为不限 */
const quizLen = ref(UPPER_LEN_ANY)
/** 出上联：语料里的原下联（大模型来源没有） */
const answer = ref('')
/** 出上联：是否已亮出参考下联 */
const showAnswer = ref(false)
/** 顶部 tabs（fixed 定位，脱离文档流） */
const tabsEl = ref<HTMLElement | null>(null)
/** tabs 的实际高度：外层占位 div 据此撑高，页面布局才不会塌 */
const { height: tabsHeight } = useElementSize(tabsEl, undefined, { box: 'border-box' })
/** 筛选侧边栏是否打开 */
const filterOpen = ref(false)
/** 画布 */
const canvas = ref<HTMLCanvasElement | null>(null)

/** 某提供者在目录里是否就绪 */
function providerReady(id: string): boolean {
  return catalog.items.value.find((i) => i.providerId === id)?.status === 'ready'
}
/** 语料库是否已安装（读 store；装好后拉一次池信息） */
const corpusInstalled = computed(() => !!store.get(COUPLET_CORPUS_ID)?.installed)
/** 对下联模型就绪 */
const coupletReady = computed(() => providerReady(PROVIDER_COUPLET))
/** 大模型就绪 */
const qwenReady = computed(() => providerReady(PROVIDER_QWEN))
/** 弹窗里的语料库行（状态读 store，下载由弹窗触发） */
const corpusRow = computed<PickerItem[]>(() => {
  const m = store.get(COUPLET_CORPUS_ID)
  return [buildExtraItem({ id: CORPUS_ROW_ID, modelId: COUPLET_CORPUS_ID, title: '语料库', desc: '73 万副真实对联，只出上联' }, m, quizSource.value === 'corpus')]
})
/** 在弹窗里选了一行：出上联时按选的是语料库还是模型切换来源 */
function onPickSource(extraId?: string): void {
  if (mode.value === 'quiz') quizSource.value = extraId === CORPUS_ROW_ID ? 'corpus' : 'llm'
}
/** 当前模式有没有可筛选的选项（对下联只有上联输入，没有） */
const hasFilter = computed(() => mode.value !== 'lower')
/** 当前模式是否用语料（随机，或出上联选了语料来源） */
const needCorpus = computed(() => mode.value === 'random' || (mode.value === 'quiz' && quizSource.value === 'corpus'))
/** 当前模式需要的东西是否就绪（探测完才提示缺失，免得一进来就闪提示） */
const missing = computed(() => {
  if (needCorpus.value) return !corpusInstalled.value
  if (!catalog.ready.value) return false
  return mode.value === 'lower' ? !coupletReady.value : !qwenReady.value
})
/** 池列表：全部在前，挽联放最后 */
const pools = computed<CorpusPool[]>(() => {
  const list = corpus.value.pools ?? []
  return [...list.filter((p) => p.name !== MOURNING_CATEGORY), ...list.filter((p) => p.name === MOURNING_CATEGORY)]
})
/** 语料池选项 */
const poolOptions = computed(() => pools.value.map((p) => ({ value: p.pool, label: p.name === MOURNING_CATEGORY ? MOURNING_LABEL : p.name })))
/** 当前池 */
const pool = computed(() => pools.value.find((p) => p.pool === poolId.value))
/** 手写软提示 */
const warnings = computed(() => customWarnings(result.value.up.trim(), result.value.down.trim(), result.value.banner.trim()))
/** 是否有可预览的内容 */
const canPreview = computed(() => !!result.value.up.trim() && !!result.value.down.trim())
/** 对下联输入的即时提示 */
const upperIssue = computed(() => (upper.value ? validateUpper(upper.value) : null))

/** 读记住的池编号 */
function readPool(): number | null {
  try {
    const v = Number(localStorage.getItem(POOL_KEY))
    return Number.isInteger(v) ? v : null
  } catch {
    return null
  }
}
/** 记住选择的池编号 */
function writePool(v: number): void {
  try {
    localStorage.setItem(POOL_KEY, String(v))
  } catch {
    /* 存不了就算了 */
  }
}

/** 拉语料库概况，并恢复上次选的池 */
async function refreshCorpus(): Promise<void> {
  try {
    corpus.value = await corpusInfo()
  } catch {
    corpus.value = { ready: false }
  }
  const saved = readPool()
  const list = corpus.value.pools ?? []
  poolId.value = list.some((p) => p.pool === saved) ? (saved as number) : 0
}
watch(corpusInstalled, (v) => (v ? void refreshCorpus() : (corpus.value = { ready: false })), { immediate: true })
watch(poolId, writePool)
watch([mode, quizSource], () => {
  if (mode.value === 'lower') filterOpen.value = false
  meta.value = ''
  showAnswer.value = false
})

/** 去 AI 中心 */
function goAiCenter(): void {
  void router.push(AI_CENTER_PATH)
}

/** 随机抽一副：游标只在取到之后才前进 */
async function runRandom(): Promise<void> {
  const p = pool.value
  const total = corpus.value.count
  if (!p || !total) return
  const d = nextDraw(loadCursor(p.name), p.count, total)
  if (!d) return
  const c = await corpusGet(p.pool, d.index)
  saveCursor(p.name, d.cursor)
  result.value = { up: c.up, down: c.down, banner: c.banner }
  mourning.value = c.cats.includes(MOURNING_CATEGORY)
  meta.value = `${c.cats.join('、')} · 本轮还剩 ${d.remaining} 副`
}

/** 出上联：语料来源，按字数抽；下联留空给用户对，原下联存起来备查 */
async function runQuizCorpus(): Promise<void> {
  const p = pool.value
  const total = corpus.value.count
  if (!p || !total) return
  const key = QUIZ_CURSOR_PREFIX + p.name
  const d = await drawByLength(loadCursor(key), p.count, total, quizLen.value, (i) => corpusGet(p.pool, i))
  if (!d) {
    showToast(MSG_QUIZ_MISS)
    return
  }
  saveCursor(key, d.cursor)
  setQuiz(d.couplet.up, d.couplet.down, d.couplet.cats.includes(MOURNING_CATEGORY))
  meta.value = `${d.couplet.cats.join('、')} · 本轮还剩 ${d.remaining} 副`
}

/** 出上联：大模型来源，只出上联 */
async function runQuizLlm(): Promise<void> {
  const r = await generateUpper({ demand: demand.value, category: category.value, len: quizLen.value }, runQwen)
  if (r.ok) {
    setQuiz(r.up, '', category.value === MOURNING_CATEGORY)
    meta.value = r.attempts > 1 ? '第一次没写工整，已自动重写一次' : ''
  } else {
    showFailToast('模型没写工整，换个说法或再试一次')
    meta.value = `不合格：${r.reason}`
  }
}

/** 出上联：落下新题，清空用户的下联与横批 */
function setQuiz(up: string, down: string, isMourning: boolean): void {
  result.value = { up, down: '', banner: '' }
  answer.value = down
  showAnswer.value = false
  mourning.value = isMourning
}

/** 对下联 */
async function runLower(): Promise<void> {
  const issue = validateUpper(upper.value)
  if (issue) {
    showToast(issue)
    return
  }
  const text = upper.value.trim()
  const r = await aiCouplet(text, {}, abort?.signal)
  result.value = { up: text, down: r.text, banner: '' }
  mourning.value = false
  meta.value = ''
}

/** 调 Qwen 跑一次提示词，返回原文 */
const runQwen: RunPrompt = async (prompt) => {
  const r = await aiInvoke(
    'prompt',
    { text: prompt },
    { provider: PROVIDER_QWEN, entry: AI_METHODS.run, options: { preset: 'prompt', temperature: QWEN_TEMPERATURE }, signal: abort?.signal },
  )
  return r.text ?? ''
}

/** 大模型：调 Qwen，按校验结果决定展示或提示 */
async function runLlm(): Promise<void> {
  const r = await generateCouplet({ demand: demand.value, wantBanner: wantBanner.value, bannerLen: bannerLen.value, category: category.value }, runQwen)
  if (r.ok) {
    result.value = r.couplet
    mourning.value = category.value === MOURNING_CATEGORY
    meta.value = r.attempts > 1 ? '第一次没写工整，已自动重写一次' : ''
  } else {
    showFailToast('模型没写工整，换个说法或再试一次')
    meta.value = `不合格：${r.reason}`
  }
}

/** 第几次执行：取消后界面立刻放开，旧任务晚到的收尾不能把新任务的状态冲掉 */
let runSeq = 0

/** 点主按钮：忙时取消（界面立刻恢复，原生那边在预填充阶段要跑完才停，最多等几秒），否则按模式执行 */
async function onRun(): Promise<void> {
  if (busy.value) {
    abort?.abort()
    busy.value = false
    return
  }
  if (missing.value) {
    showToast(needCorpus.value ? MSG_CORPUS_MISSING : MSG_NOT_READY)
    return
  }
  abort = new AbortController()
  busy.value = true
  const seq = ++runSeq
  try {
    if (mode.value === 'random') await runRandom()
    else if (mode.value === 'lower') await runLower()
    else if (mode.value === 'quiz') await (quizSource.value === 'corpus' ? runQuizCorpus() : runQuizLlm())
    else await runLlm()
  } catch (e) {
    if (isAiCancelled(e)) return
    if (e instanceof AiNotReadyError) {
      showToast(MSG_NOT_READY)
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

/** 复制当前这副文字 */
async function copyCurrent(): Promise<void> {
  const p = result.value
  if (!p.up || !p.down) return
  const lines = [`上联：${p.up}`, `下联：${p.down}`]
  if (p.banner) lines.push(`横批：${p.banner}`)
  const ok = await copyText(lines.join('\n'))
  if (ok) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}

/** 导出图的像素倍率（预览与导出共用同一块 canvas，按 3 倍画保证清晰） */
const PIXEL_RATIO = 3
/** 当前对联图布局（空对联也有布局：固定大小的红底牌匾、联条和福字） */
const layout = computed(() => layoutCouplet(result.value.up.trim(), result.value.down.trim(), result.value.banner.trim(), mourning.value))
/** canvas 的显示尺寸（CSS px）；窄屏等比缩小 */
const canvasStyle = computed(() => ({ width: `${layout.value.width}px`, aspectRatio: `${layout.value.width} / ${layout.value.height}` }))

/** 重绘对联图 */
async function redraw(): Promise<void> {
  await nextTick()
  const el = canvas.value
  if (!el) return
  const l = layout.value
  // 先设宽高（会清空画布）再缩放、绘制
  el.width = Math.round(l.width * PIXEL_RATIO)
  el.height = Math.round(l.height * PIXEL_RATIO)
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO)
  drawCouplet(ctx, l)
}
/** 重绘，并在在线字体就绪后再画一次（没网时不影响，沿用系统字体） */
async function redrawWithFont(): Promise<void> {
  await redraw()
  const l = layout.value
  await waitCoupletFont(`${l.banner.text}${l.items.map((i) => i.ch).join('')}${COUPLET_SPEC.fuChar}`)
  await redraw()
}
watch([result, mourning], redrawWithFont, { flush: 'post', deep: true })
onMounted(() => {
  loadCoupletFont()
  void redrawWithFont()
})

/** 导出 PNG */
async function save(): Promise<void> {
  if (!canvas.value || !canPreview.value) return
  await redrawWithFont()
  try {
    const res = await saveBlob(await canvasToBlob(canvas.value, 'image/png'), FILE_NAME)
    showSuccessToast(res.mode === 'native' ? '已保存到相册' : '已开始下载')
  } catch {
    showFailToast('保存失败，请重试')
  }
}

/** 主按钮文案 */
const runText = computed(() => {
  if (busy.value) return '取消'
  if (mode.value === 'quiz') return '出上联'
  return mode.value === 'random' ? '抽一副' : mode.value === 'lower' ? '对下联' : '生成'
})
onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <div class="tool-page">
    <div class="cp-tabs-holder" :style="{ height: `${tabsHeight}px` }">
      <van-tabs ref="tabsEl" v-model:active="mode" class="cp-tabs" type="card" :swipeable="false">
        <van-tab title="随机" name="random" />
        <van-tab title="出上联" name="quiz" />
        <van-tab title="对下联" name="lower" />
        <van-tab title="趣味问答" name="llm" />
      </van-tabs>
    </div>

    <van-notice-bar v-if="missing && needCorpus" mode="link" wrapable :scrollable="false" left-icon="info-o" @click="goAiCenter">
      {{ MSG_CORPUS_MISSING }}
    </van-notice-bar>
    <model-missing-notice v-else-if="missing" />

    <tool-group v-if="mode === 'lower'" title="写上联">
      <van-field v-model="upper" placeholder="如：春风送暖入屠苏" maxlength="14" clearable />
      <p v-if="upperIssue" class="tool-hint">{{ upperIssue }}</p>
      <p v-else class="tool-hint">本地小模型对下联，字数与上联相同，最多 14 字。</p>
    </tool-group>

    <tool-group v-if="mode === 'llm' || (mode === 'quiz' && quizSource === 'llm')" title="你的要求">
      <van-field v-model="demand" type="textarea" rows="2" autosize maxlength="100" placeholder="如：写给爱喝茶的爷爷，不填则自由发挥" />
    </tool-group>

    <teleport to="#shell-nav-actions" defer>
      <van-icon v-if="hasFilter" name="filter-o" class="cp-filter" role="button" aria-label="筛选" @click.stop="filterOpen = true" />
    </teleport>

    <van-popup v-model:show="filterOpen" position="right" teleport="body" :style="{ width: '82%', height: '100%' }">
      <div class="cp-filter-panel">
            <template v-if="mode === 'quiz'">
              <p class="tool-hint">当前来源：{{ quizSource === 'corpus' ? '语料库' : '大模型' }}（点底部 AI 图标切换）；对完可点「看参考」对照，仅语料库有原下联。</p>

              <tool-group v-if="quizSource === 'corpus'">
                <cell-picker :model-value="poolId" title="类型" :options="poolOptions" @update:model-value="poolId = $event as number" />
              </tool-group>
              <template v-else>
                <tool-group>
                  <cell-picker :model-value="category" title="类型" :options="CATEGORY_OPTIONS" @update:model-value="category = $event as string" />
                  <p class="tool-hint">{{ MSG_REVIEW }}</p>
                </tool-group>
              </template>

              <tool-group>
                <cell-picker :model-value="quizLen" title="上联字数" :options="QUIZ_LEN_OPTIONS" @update:model-value="quizLen = $event as number" />
              </tool-group>
            </template>

            <tool-group v-else-if="mode === 'random'">
              <cell-picker :model-value="poolId" title="类型" :options="poolOptions" @update:model-value="poolId = $event as number" />
              <p v-if="pool" class="tool-hint">该类共 {{ pool.count }} 副，抽完一轮才会重复。默认的「全部」不含挽联，想看挽联要单独选。</p>
              <p class="tool-hint">{{ MSG_RANDOM_NOTE }}</p>
            </tool-group>
            <template v-else-if="mode === 'llm'">
              <tool-group>
                <cell-picker :model-value="bannerChoice" title="横批" :options="BANNER_OPTIONS" @update:model-value="bannerChoice = $event as number" />
              </tool-group>

              <tool-group>
                <cell-picker :model-value="category" title="类型" :options="CATEGORY_OPTIONS" @update:model-value="category = $event as string" />
                <p class="tool-hint">{{ MSG_REVIEW }}</p>
              </tool-group>
            </template>
      </div>
    </van-popup>

    <tool-group title="结果（可手改）">
      <van-field v-model="result.up" type="textarea" rows="1" autosize label="上联" placeholder="上联" @keydown.enter.prevent />
      <van-field v-model="result.down" type="textarea" rows="1" autosize label="下联" placeholder="下联" @keydown.enter.prevent />
      <van-field v-model="result.banner" type="textarea" rows="1" autosize label="横批" placeholder="横批，可不填" @keydown.enter.prevent />
      <p v-if="meta" class="tool-hint">{{ meta }}</p>
      <template v-if="mode === 'quiz' && answer">
        <van-button size="small" plain class="cp-gap" @click="showAnswer = !showAnswer">{{ showAnswer ? '收起参考' : '看参考' }}</van-button>
        <p v-if="showAnswer" class="tool-hint">参考下联：{{ answer }}（仅供对照，对法不止一种）</p>
      </template>
      <p v-for="w in warnings" :key="w" class="tool-hint">提示：{{ w }}</p>
      <div class="cp-preview">
        <canvas ref="canvas" class="cp-canvas" :style="canvasStyle" />
      </div>
    </tool-group>

    <bottom-actions :actions="{ copy: { disabled: !canPreview }, save: { disabled: !canPreview, text: '导出图' } }" ai main :main-text="runText" :main-type="busy ? 'danger' : 'primary'" @main="onRun" @copy="copyCurrent" @save="save">
      <template #ai>
        <model-picker :tool-id="TOOL_ID" variant="bar" :disabled="mode === 'random'" :extra="mode === 'quiz' ? corpusRow : undefined" @picked="onPickSource" />
      </template>
    </bottom-actions>
  </div>
</template>

<style lang="scss" scoped>
.cp-tabs-holder {
  position: relative;
}
/* 固定在导航栏下面、铺满左右；不透明底色，内容从下面滚过去时不透字 */
.cp-tabs {
  position: fixed;
  top: calc(var(--van-nav-bar-height, 46px) + var(--safe-top));
  left: 0;
  right: 0;
  z-index: 10;
  background: var(--c-bg);
}
/* 卡片式导航去圆角 */
.cp-tabs :deep(.van-tabs__nav--card) {
  border-radius: 0;
}
.cp-filter {
  font-size: 22px;
  color: var(--c-text-muted);
  margin-right: $space-3;
}
.cp-filter-panel {
  padding: 12px;
  padding-top: calc(12px + var(--safe-top));
}
.cp-gap {
  margin: $space-2 0;
}
/* 预览区：canvas 始终显示，没内容时是空红底的固定版式，不会跳动 */
.cp-preview {
  display: flex;
  justify-content: center;
  margin: $space-3 0;
}
.cp-canvas {
  display: block;
  max-width: 100%;
  height: auto;
}
</style>
