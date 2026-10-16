<script setup lang="ts">
// 对联：三种出法。随机=从 73 万副语料里不重复地抽（原生按下标取，不读全量）；对下联=本地 GPT-2 按上联生成等长下联；
// 大模型=本地 Qwen 按用户要求生成（可选横批、字数、类型，输出会校验，不合格重试一次）。
// 出来的对联可以微调，画成红底金字的竖排图并导出 PNG。模型与语料的状态只读（目录与 store），下载等都在 AI 中心。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import BottomActions from '@/shared/BottomActions.vue'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import type { BottomActionItem } from '@/shared/bottomActions'
import { copyText } from '@/shared/clipboard'
import { canvasToBlob, saveBlob } from '@/shared/image-io'
import { AI_CENTER_PATH } from '@/shared/modelPicker'
import { AiNotReadyError, aiCouplet, aiInvoke, isAiCancelled } from '@/native/ai'
import { AI_METHODS } from '@/native/aiMethods'
import { corpusGet, corpusInfo, COUPLET_CORPUS_ID, type CorpusInfo, type CorpusPool } from '@/native/corpus'
import { useAiCatalog } from '@/native/useAiCatalog'
import { useModelsStore } from '@/stores/models'
import { loadCursor, nextDraw, saveCursor } from './cursor'
import {
  BANNER_DEFAULT,
  BANNER_MAX,
  BANNER_MIN,
  CATEGORY_HINTS,
  generateCouplet,
  validateUpper,
  type Couplet,
  type RunPrompt,
} from './generate'
import { customWarnings, drawCouplet, layoutCouplet } from './logic'

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
type Mode = 'random' | 'lower' | 'llm'
/** 动作项 key */
const ACT_COPY = 'copy'
const ACT_SAVE = 'save'
const ACT_RUN = 'run'
/** 大模型采样温度：写对联需要一点发散，又不能太散 */
const QWEN_TEMPERATURE = 0.7
/** 横批字数候选 */
const BANNER_LENS = Array.from({ length: BANNER_MAX - BANNER_MIN + 1 }, (_, i) => BANNER_MIN + i)
/** 提示条文案 */
const MSG_CORPUS_MISSING = '随机模式需要对联语料库，请先下载'
const MSG_NOT_READY = '模型还没就绪，请先下载'
const MSG_REVIEW = '提示：0.8B 小模型会写出不工整甚至不通的句子，请自己把关'
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
/** 大模型：要不要横批 */
const wantBanner = ref(true)
/** 大模型：横批字数 */
const bannerLen = ref(BANNER_DEFAULT)
/** 大模型：类型 */
const category = ref('通用')
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
/** 当前模式需要的东西是否就绪（探测完才提示缺失，免得一进来就闪提示） */
const missing = computed(() => {
  if (mode.value === 'random') return !corpusInstalled.value
  if (!catalog.ready.value) return false
  return mode.value === 'lower' ? !coupletReady.value : !qwenReady.value
})
/** 池列表：全部在前，挽联放最后 */
const pools = computed<CorpusPool[]>(() => {
  const list = corpus.value.pools ?? []
  return [...list.filter((p) => p.name !== '挽联'), ...list.filter((p) => p.name === '挽联')]
})
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
watch(mode, () => (meta.value = ''))

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
  meta.value = `${c.cats.join('、')} · 本轮还剩 ${d.remaining} 副`
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
  meta.value = ''
}

/** 大模型：调 Qwen，按校验结果决定展示或提示 */
async function runLlm(): Promise<void> {
  const run: RunPrompt = async (prompt) => {
    const r = await aiInvoke(
      'prompt',
      { text: prompt },
      { provider: PROVIDER_QWEN, entry: AI_METHODS.run, options: { preset: 'prompt', temperature: QWEN_TEMPERATURE }, signal: abort?.signal },
    )
    return r.text ?? ''
  }
  const r = await generateCouplet({ demand: demand.value, wantBanner: wantBanner.value, bannerLen: bannerLen.value, category: category.value }, run)
  if (r.ok) {
    result.value = r.couplet
    meta.value = r.attempts > 1 ? '第一次没写工整，已自动重写一次' : ''
  } else {
    showFailToast('模型没写工整，换个说法或再试一次')
    meta.value = `不合格：${r.reason}`
  }
}

/** 点主按钮：忙时取消，否则按模式执行 */
async function onRun(): Promise<void> {
  if (busy.value) {
    abort?.abort()
    return
  }
  if (missing.value) {
    showToast(mode.value === 'random' ? MSG_CORPUS_MISSING : MSG_NOT_READY)
    return
  }
  abort = new AbortController()
  busy.value = true
  try {
    if (mode.value === 'random') await runRandom()
    else if (mode.value === 'lower') await runLower()
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
    busy.value = false
    abort = null
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

/** 重绘对联图 */
async function redraw(): Promise<void> {
  await nextTick()
  const el = canvas.value
  if (!el || !canPreview.value) return
  const layout = layoutCouplet(result.value.up.trim(), result.value.down.trim(), result.value.banner.trim())
  // 先设宽高（会清空画布）再画
  el.width = layout.width
  el.height = layout.height
  const ctx = el.getContext('2d')
  if (ctx) drawCouplet(ctx, layout)
}
watch(result, redraw, { flush: 'post', deep: true })

/** 导出 PNG */
async function save(): Promise<void> {
  if (!canvas.value || !canPreview.value) return
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
  return mode.value === 'random' ? '抽一副' : mode.value === 'lower' ? '对下联' : '生成'
})
/** 底部动作栏 */
const actions = computed<BottomActionItem[]>(() => [
  { key: ACT_COPY, icon: 'description-o', text: '复制', disabled: !canPreview.value },
  { key: ACT_SAVE, icon: 'down', text: '导出图', disabled: !canPreview.value },
  { key: ACT_RUN, kind: 'button', text: runText.value, type: busy.value ? 'default' : 'primary' },
])
/** 点动作项 */
function onAction(key: string): void {
  if (key === ACT_COPY) void copyCurrent()
  else if (key === ACT_SAVE) void save()
  else void onRun()
}

onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="mode" type="card" :swipeable="false">
      <van-tab title="随机" name="random" />
      <van-tab title="对下联" name="lower" />
      <van-tab title="大模型" name="llm" />
    </van-tabs>

    <van-notice-bar v-if="missing && mode === 'random'" mode="link" wrapable :scrollable="false" left-icon="info-o" @click="goAiCenter">
      {{ MSG_CORPUS_MISSING }}
    </van-notice-bar>
    <model-missing-notice v-else-if="missing" />

    <div v-if="mode === 'random'" class="tool-card">
      <h3 class="tool-card__title">类型</h3>
      <van-radio-group v-model="poolId" direction="horizontal" class="cp-gap">
        <van-radio v-for="p in pools" :key="p.pool" :name="p.pool">{{ p.name === '挽联' ? '挽联（哀悼）' : p.name }}</van-radio>
      </van-radio-group>
      <p v-if="pool" class="tool-hint">该类共 {{ pool.count }} 副，抽完一轮才会重复。默认的「全部」不含挽联，想看挽联要单独选。</p>
      <p class="tool-hint">{{ MSG_RANDOM_NOTE }}</p>
    </div>

    <div v-else-if="mode === 'lower'" class="tool-card">
      <h3 class="tool-card__title">写上联</h3>
      <van-field v-model="upper" placeholder="如：春风送暖入屠苏" maxlength="14" clearable />
      <p v-if="upperIssue" class="tool-hint">{{ upperIssue }}</p>
      <p v-else class="tool-hint">本地小模型对下联，字数与上联相同，最多 14 字。</p>
    </div>

    <div v-else class="tool-card">
      <h3 class="tool-card__title">你的要求</h3>
      <van-field v-model="demand" type="textarea" rows="2" autosize maxlength="100" placeholder="如：写给爱喝茶的爷爷，不填则自由发挥" />
      <van-cell center title="要横批">
        <template #right-icon><van-switch v-model="wantBanner" size="20" /></template>
      </van-cell>
      <van-radio-group v-if="wantBanner" v-model="bannerLen" direction="horizontal" class="cp-gap">
        <van-radio v-for="n in BANNER_LENS" :key="n" :name="n">{{ n }} 字</van-radio>
      </van-radio-group>
      <h3 class="tool-card__title">类型</h3>
      <van-radio-group v-model="category" direction="horizontal" class="cp-gap">
        <van-radio v-for="c in CATEGORY_HINTS" :key="c.name" :name="c.name">{{ c.name }}</van-radio>
      </van-radio-group>
      <p class="tool-hint">{{ MSG_REVIEW }}</p>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">结果（可手改）</h3>
      <van-field v-model="result.up" label="上联" placeholder="上联" />
      <van-field v-model="result.down" label="下联" placeholder="下联" />
      <van-field v-model="result.banner" label="横批" placeholder="横批，可不填" />
      <p v-if="meta" class="tool-hint">{{ meta }}</p>
      <p v-for="w in warnings" :key="w" class="tool-hint">提示：{{ w }}</p>
      <div v-if="canPreview" class="cp-preview">
        <canvas ref="canvas" class="cp-canvas" />
      </div>
      <p v-else class="tool-hint">出了对联，对联图会显示在这里</p>
    </div>

    <bottom-actions :items="actions" @select="onAction" />
  </div>
</template>

<style lang="scss" scoped>
.cp-gap {
  margin: $space-2 0;
}
.cp-preview {
  display: flex;
  justify-content: center;
  margin: $space-3 0;
}
.cp-canvas {
  max-width: 100%;
  height: auto;
}
</style>
