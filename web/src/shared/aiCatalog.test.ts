import { describe, expect, it } from 'vitest'
import type { AiProviderInfo, AiTask } from '@/native/ai'
import type { ModelStatus } from '@/native/model'
import { findTool, hasAiChoices, tools, type ToolAiTask, type ToolModelOption } from '@/tools/registry'
import {
  L4_OPENAI_ID,
  LEGACY_CHOICE_MIGRATION,
  buildCatalog,
  describeOffers,
  hasSession,
  migrateChoice,
  modelKey,
  resolveChoice,
  sessionProviderOf,
  staticDefault,
  type CatalogItem,
} from './aiCatalog'

/** 原生 AiTranslatePolicy.LANGS（NLLB 与 Qwen 共用） */
const UN6 = ['zh-CN', 'en', 'fr', 'es', 'ru', 'ar']
/** 原生翻译报价的约束 */
const TR_CONSTRAINTS = { languages: UN6, sourceAuto: true }
/** Qwen 经 run 承接的任务 */
const QWEN_RUN: AiTask[] = ['summarize', 'proofread', 'rewrite', 'prompt']

/** 与原生 `AiModule.providers` + `AiPolicy.providersJson` 同形的五个提供者（注册顺序） */
function nativeProviders(over: Partial<Record<string, Partial<AiProviderInfo>>> = {}): AiProviderInfo[] {
  const list: AiProviderInfo[] = [
    {
      id: 'intent-handoff',
      displayName: '系统应用交接',
      layer: 'L3',
      available: true,
      session: false,
      tasks: ['summarize', 'proofread', 'rewrite', 'prompt', 'translate'],
      offers: (['summarize', 'proofread', 'rewrite', 'prompt', 'translate'] as AiTask[]).map((task) => ({ task, entry: 'native.ai.run' })),
    },
    {
      id: 'local-clip',
      displayName: '本地识物（SigLIP2）',
      layer: 'L1',
      available: true,
      session: true,
      tasks: ['classifyImage'],
      offers: [{ task: 'classifyImage', entry: 'native.ai.classify' }],
      modelId: 'siglip2-mnn-w8',
      downloaded: true,
      sizeBytes: 54662805,
      downloading: false,
    },
    {
      id: 'local-ocr',
      displayName: '本地文字识别（PP-OCRv6）',
      layer: 'L1',
      available: false,
      reason: 'not_installed',
      session: true,
      tasks: ['ocr'],
      offers: [{ task: 'ocr', entry: 'native.ai.ocr' }],
      modelId: 'ppocrv6-small-mnn-fp16',
      downloaded: false,
      sizeBytes: 0,
      downloading: false,
    },
    {
      id: 'local-nllb',
      displayName: '本地翻译（NLLB）',
      layer: 'L1',
      available: false,
      reason: 'not_installed',
      session: true,
      tasks: ['translate'],
      offers: [{ task: 'translate', entry: 'native.ai.translate', constraints: TR_CONSTRAINTS }],
      modelId: 'nllb600m-un6-mnn-w6',
      downloaded: false,
      sizeBytes: 0,
      downloading: false,
    },
    {
      id: 'local-qwen',
      displayName: '本地文本模型（Qwen）',
      layer: 'L2',
      available: false,
      reason: 'not_installed',
      session: true,
      tasks: ['summarize', 'proofread', 'rewrite', 'prompt', 'translate'],
      offers: [
        ...QWEN_RUN.map((task) => ({ task, entry: 'native.ai.run' })),
        { task: 'translate' as const, entry: 'native.ai.translate', constraints: TR_CONSTRAINTS },
      ],
      modelId: 'qwen35-0.8b-mnn-q4',
      downloaded: false,
      sizeBytes: 0,
      downloading: false,
    },
  ]
  return list.map((p) => ({ ...p, ...(over[p.id] ?? {}) }))
}

/** 造一条模型 store 状态 */
function st(id: string, state: ModelStatus['state'], total = 1000, done = total): ModelStatus {
  return { id, displayName: id, version: '1', state, totalBytes: total, downloadedBytes: done, diskBytes: done }
}

/** 按 registry 里真实工具的声明建目录 */
function catalogOf(toolId: string, providers = nativeProviders(), statuses: Record<string, ModelStatus> = {}): CatalogItem[] {
  const t = findTool(toolId)
  return buildCatalog({ tasks: t?.tasks ?? [], models: t?.models ?? [], providers, statuses })
}

/** 按任意声明建目录（造假工具用） */
function catalogFor(tasks: ToolAiTask[], models: ToolModelOption[] = [], providers = nativeProviders(), statuses: Record<string, ModelStatus> = {}): CatalogItem[] {
  return buildCatalog({ tasks, models, providers, statuses })
}

describe('适用性回归（registry 里的真实工具）', () => {
  it('垃圾分类：只有识物，没有 Qwen、没有交接、没有 L4 占位；沿用工具文案', () => {
    const items = catalogOf('waste-sort')
    expect(items.map((i) => i.key)).toEqual(['local-clip'])
    expect(items[0]).toMatchObject({ layer: 'L1', title: '识物 SigLIP2（MNN）', desc: '识别垃圾品类', modelId: 'siglip2-mnn-w8', providerId: 'local-clip' })
  })
  it('OCR：只有原生的 local-ocr，没有过渡项、Qwen、交接、L4 占位；状态读 store', () => {
    const items = catalogOf('ocr')
    expect(items.map((i) => i.key)).toEqual(['local-ocr'])
    expect(items[0]).toMatchObject({ layer: 'L1', status: 'missing', modelId: 'ppocrv6-small-mnn-fp16', providerId: 'local-ocr', entries: { ocr: 'native.ai.ocr' }, session: true })
    const installed = catalogOf('ocr', nativeProviders(), { 'ppocrv6-small-mnn-fp16': st('ppocrv6-small-mnn-fp16', 'installed') })
    expect(installed[0].status).toBe('ready')
    const downloading = catalogOf('ocr', nativeProviders(), { 'ppocrv6-small-mnn-fp16': st('ppocrv6-small-mnn-fp16', 'downloading', 1000, 300) })
    expect(downloading[0]).toMatchObject({ status: 'loading', downloadedBytes: 300 })
  })
  it('图片转表格用同一份文字识别目录', () => {
    expect(catalogOf('table-extract').map((i) => i.key)).toEqual(['local-ocr'])
  })
  it('翻译：NLLB 与 Qwen 都在，交接（经 run）不在，补 L4 占位；语言清单来自原生报价', () => {
    const items = catalogOf('translate')
    expect(items.map((i) => i.key)).toEqual(['local-nllb', 'local-qwen', L4_OPENAI_ID])
    expect(items[0]).toMatchObject({ layer: 'L1', status: 'missing', constraints: TR_CONSTRAINTS, entries: { translate: 'native.ai.translate' } })
    expect(items[1]).toMatchObject({ layer: 'L2', constraints: TR_CONSTRAINTS })
    expect(items[2]).toMatchObject({ layer: 'L4', status: 'unsupported', selectable: false })
  })
  it('对联：任务 couplet 的目录只有原生的 local-couplet（专用端口，不混进 Qwen、交接）', () => {
    const couplet: AiProviderInfo = {
      id: 'local-couplet',
      displayName: '本地对联（GPT-2）',
      layer: 'L1',
      available: false,
      reason: 'not_installed',
      session: true,
      tasks: ['couplet'],
      offers: [{ task: 'couplet', entry: 'native.ai.couplet', constraints: { maxChars: 14, temperature: { min: 0, max: 2 }, topK: { min: 1, max: 200 } } }],
      modelId: 'couplet-gpt2-mnn-w6',
      downloaded: false,
      sizeBytes: 0,
      downloading: false,
    }
    const tasks: ToolAiTask[] = [{ task: 'couplet', entry: 'native.ai.couplet' }]
    const items = catalogFor(tasks, [], [...nativeProviders(), couplet])
    expect(items.map((i) => i.key)).toEqual(['local-couplet'])
    expect(items[0]).toMatchObject({ layer: 'L1', status: 'missing', modelId: 'couplet-gpt2-mnn-w6', providerId: 'local-couplet', entries: { couplet: 'native.ai.couplet' }, session: true })
    expect(items[0].constraints?.maxChars).toBe(14)
    const installed = catalogFor(tasks, [], [...nativeProviders(), couplet], { 'couplet-gpt2-mnn-w6': st('couplet-gpt2-mnn-w6', 'installed') })
    expect(installed[0].status).toBe('ready')
  })
  it('所有没声明文本任务的 AI 工具都看不到 Qwen 与 L4 占位', () => {
    const textTasks: AiTask[] = ['summarize', 'proofread', 'rewrite', 'prompt', 'translate']
    const offenders = tools
      .filter((t) => hasAiChoices(t))
      .filter((t) => !(t.tasks ?? []).some((x) => textTasks.includes(typeof x === 'string' ? x : x.task)))
      .filter((t) => catalogOf(t.id).some((i) => i.key === 'local-qwen' || i.key === L4_OPENAI_ID))
      .map((t) => t.id)
    expect(offenders).toEqual([])
  })
  it('各 AI 工具声明的任务（改了要同步文档与汇报）', () => {
    const declared = Object.fromEntries(tools.filter((t) => hasAiChoices(t)).map((t) => [t.id, (t.tasks ?? []).map((x) => (typeof x === 'string' ? x : `${x.task}@${x.entry}`))]))
    expect(declared).toEqual({
      'waste-sort': ['classifyImage'],
      translate: ['translate@native.ai.translate'],
      ocr: ['ocr@native.ai.ocr'],
      'table-extract': ['ocr@native.ai.ocr'],
      couplet: ['couplet@native.ai.couplet', 'prompt@native.ai.run'],
      'image-upscale': [],
      'object-count': [],
      'face-fusion': [],
      colorize: [],
    })
  })
})

describe('适用性（声明了文本任务的工具）', () => {
  it('声明 summarize/prompt：Qwen（L2）与可用的交接（L3）都在，补 L4 占位', () => {
    const items = catalogFor(['summarize', 'prompt'])
    expect(items.map((i) => i.key)).toEqual(['local-qwen', 'intent-handoff', L4_OPENAI_ID])
    expect(items[0]).toMatchObject({ desc: '摘要、问答', entries: { summarize: 'native.ai.run', prompt: 'native.ai.run' } })
    expect(items[1]).toMatchObject({ layer: 'L3', status: 'ready' })
  })
  it('本机 AI 不可用就隐藏（不置灰）；本地模型没下载仍显示为未下载', () => {
    const items = catalogFor(['summarize'], [], nativeProviders({ 'intent-handoff': { available: false, reason: 'no_handler' } }))
    expect(items.map((i) => i.key)).toEqual(['local-qwen', L4_OPENAI_ID])
    expect(items[0].status).toBe('missing')
  })
  it('只写任务名不限入口：翻译类工具若不限入口，交接也会出现', () => {
    expect(catalogFor(['translate']).map((i) => i.key)).toEqual(['local-nllb', 'local-qwen', 'intent-handoff', L4_OPENAI_ID])
  })
})

describe('状态与合并', () => {
  it('状态优先读模型 store；store 还没有时用提供者自带的下载信息', () => {
    const fromStore = catalogOf('translate', nativeProviders(), { 'qwen35-0.8b-mnn-q4': st('qwen35-0.8b-mnn-q4', 'downloading', 100, 37) })
    expect(fromStore[1]).toMatchObject({ status: 'loading', totalBytes: 100, downloadedBytes: 37 })
    const fromProvider = catalogOf('waste-sort', nativeProviders(), {})
    expect(fromProvider[0]).toMatchObject({ status: 'ready', totalBytes: 54662805 })
    const downloading = catalogOf('translate', nativeProviders({ 'local-nllb': { downloading: true } }))
    expect(downloading[0].status).toBe('loading')
  })
  it('store 说已安装就是 ready，不看提供者的 available', () => {
    const items = catalogOf('translate', nativeProviders(), { 'nllb600m-un6-mnn-w6': st('nllb600m-un6-mnn-w6', 'installed') })
    expect(items[0].status).toBe('ready')
  })
  it('过渡清单模型按 modelId 并进提供者项，不重复；没有提供者的按清单状态出项', () => {
    const models: ToolModelOption[] = [
      { modelId: 'siglip2-mnn-w8', title: '识物', desc: '识别' },
      { modelId: 'ocr', title: 'OCR', desc: '图片转文字' },
    ]
    const items = catalogFor(['classifyImage'], models, nativeProviders(), { ocr: st('ocr', 'absent') })
    expect(items.map((i) => i.key)).toEqual(['local-clip', modelKey('ocr')])
    expect(items[1]).toMatchObject({ status: 'missing', title: 'OCR' })
  })
  it('旧原生没有 offers：不出任何提供者项（过渡项照常）', () => {
    const old = nativeProviders().map(({ offers: _o, layer: _l, ...rest }) => rest)
    expect(catalogOf('translate', old).map((i) => i.key)).toEqual([L4_OPENAI_ID])
    expect(catalogOf('waste-sort', old).map((i) => i.key)).toEqual([modelKey('siglip2-mnn-w8')])
  })
  it('按层排序，同层保持注册顺序', () => {
    const items = catalogFor(['translate'])
    expect(items.map((i) => i.layer)).toEqual(['L1', 'L2', 'L3', 'L4'])
  })
})

describe('备注', () => {
  it('翻译带语言清单写「N 种语言互译」，其余写任务名', () => {
    expect(describeOffers([{ task: 'translate', entry: 'native.ai.translate', constraints: TR_CONSTRAINTS }])).toBe('6 种语言互译')
    expect(describeOffers([{ task: 'translate', entry: 'native.ai.run' }, { task: 'classifyImage', entry: 'native.ai.classify' }])).toBe('翻译、识图')
  })
})

describe('选择解析', () => {
  /** 翻译目录：NLLB 已装、Qwen 未装 */
  const items = catalogOf('translate', nativeProviders(), { 'nllb600m-un6-mnn-w6': st('nllb600m-un6-mnn-w6', 'installed') })

  it('存值有效就用它（没装好也保留，交给页面提示）', () => {
    expect(resolveChoice('local-qwen', items)).toBe('local-qwen')
    expect(resolveChoice('local-nllb', items)).toBe('local-nllb')
  })
  it('旧的清单 id、model: 前缀能按 modelId 对上提供者项', () => {
    expect(resolveChoice('qwen35-0.8b-mnn-q4', items)).toBe('local-qwen')
    expect(resolveChoice(modelKey('nllb600m-un6-mnn-w6'), items)).toBe('local-nllb')
  })
  it('失效值、占位、空值回落到第一个 ready 的 L1', () => {
    expect(resolveChoice('gone', items)).toBe('local-nllb')
    expect(resolveChoice(L4_OPENAI_ID, items)).toBe('local-nllb')
    expect(resolveChoice(null, items)).toBe('local-nllb')
  })
  it('没有 ready 的 L1 取第一个 L1；没有 L1 取 L2（即使它没下载、交接却可用）；全无为 null', () => {
    const none = catalogOf('translate')
    expect(resolveChoice('gone', none)).toBe('local-nllb')
    expect(resolveChoice(null, catalogFor(['summarize']))).toBe('local-qwen')
    expect(resolveChoice('x', [])).toBeNull()
    expect(resolveChoice('x', catalogFor(['summarize'], [], []))).toBeNull()
  })
  it('不会自动回落到本机 AI 交接（隐私：默认不启用），但用户选过的交接照常保留', () => {
    const onlyHandoff = catalogFor(['summarize'], [], nativeProviders().filter((p) => p.id === 'intent-handoff'))
    expect(onlyHandoff.map((i) => i.key)).toEqual(['intent-handoff', L4_OPENAI_ID])
    expect(resolveChoice(null, onlyHandoff)).toBeNull()
    expect(resolveChoice('intent-handoff', onlyHandoff)).toBe('intent-handoff')
  })
})

describe('旧值迁移', () => {
  it('迁移表：L1/L2 旧清单 id → 提供者 id；早期 L2 占位丢弃', () => {
    expect(Object.fromEntries(LEGACY_CHOICE_MIGRATION)).toEqual({
      'siglip2-q4_half': 'local-clip',
      'siglip2-mnn-w8': 'local-clip',
      'nllb600m-un6-ccm-int4': 'local-nllb',
      'nllb600m-un6-mnn-w6': 'local-nllb',
      'qwen35-0.8b-mnn-q4': 'local-qwen',
      ocr: 'local-ocr',
      'ppocrv5-mnn-fp16': 'local-ocr',
      'l2-none': null,
    })
    expect(migrateChoice('nllb600m-un6-ccm-int4', [])).toBe('local-nllb')
    expect(migrateChoice('nllb600m-un6-mnn-w6', [])).toBe('local-nllb')
    expect(migrateChoice('qwen35-0.8b-mnn-q4', [])).toBe('local-qwen')
    expect(migrateChoice('siglip2-q4_half', ['siglip2-mnn-w8'])).toBe('local-clip')
    expect(migrateChoice('siglip2-mnn-w8', ['siglip2-mnn-w8'])).toBe('local-clip')
    expect(migrateChoice('l2-none', [])).toBeNull()
    // 文字识别：旧的清单占位 id 与真实模型 id 都迁到提供者
    expect(migrateChoice('ocr', [])).toBe('local-ocr')
    expect(migrateChoice('ppocrv5-mnn-fp16', [])).toBe('local-ocr')
  })
  it('工具声明过的过渡清单模型迁成 model: 前缀；已是新值或认不出的原样返回', () => {
    expect(migrateChoice('image-upscale', ['image-upscale'])).toBe('model:image-upscale')
    expect(migrateChoice('model:image-upscale', ['image-upscale'])).toBe('model:image-upscale')
    expect(migrateChoice('local-qwen', [])).toBe('local-qwen')
    expect(migrateChoice('intent-handoff', [])).toBe('intent-handoff')
    expect(migrateChoice('toString', [])).toBe('toString')
    expect(migrateChoice(null, ['image-upscale'])).toBeNull()
  })
  it('迁移幂等', () => {
    for (const raw of ['siglip2-q4_half', 'siglip2-mnn-w8', 'ocr', 'image-upscale', 'local-nllb', 'l4-openai']) {
      const once = migrateChoice(raw, ['image-upscale'])
      expect(migrateChoice(once, ['image-upscale'])).toBe(once)
    }
  })
  it('静态默认：第一个过渡清单模型迁移后的值', () => {
    expect(staticDefault(findTool('waste-sort')?.models ?? [])).toBe('local-clip')
    // 文字识别已改成只声明任务，没有过渡清单模型
    expect(staticDefault(findTool('ocr')?.models ?? [])).toBeNull()
    expect(staticDefault(findTool('image-upscale')?.models ?? [])).toBe('model:image-upscale')
    expect(staticDefault([])).toBeNull()
  })
})

describe('会话（预热跟随）', () => {
  it('目录项的 session 来自原生；交接、过渡项、L4 占位都没有会话', () => {
    const items = catalogFor(['translate'], [{ modelId: 'ocr', title: 'OCR', desc: '' }])
    const byKey = Object.fromEntries(items.map((i) => [i.key, i.session]))
    expect(byKey).toEqual({ 'local-nllb': true, 'local-qwen': true, 'intent-handoff': false, [modelKey('ocr')]: false, [L4_OPENAI_ID]: false })
  })
  it('sessionProviderOf：只有声明了会话的才返回提供者 id', () => {
    const items = catalogFor(['translate'])
    expect(items.map(sessionProviderOf)).toEqual(['local-nllb', 'local-qwen', undefined, undefined])
    expect(sessionProviderOf(null)).toBeUndefined()
    expect(sessionProviderOf(undefined)).toBeUndefined()
  })
  it('新原生说没有会话就不预热，哪怕依赖本地模型；旧原生没有该字段时按“有本地模型”兜底', () => {
    const noSession = nativeProviders({ 'local-nllb': { session: false } })
    expect(sessionProviderOf(catalogOf('translate', noSession)[0])).toBeUndefined()
    const old = nativeProviders().map(({ session: _s, ...rest }) => rest)
    expect(old.map(hasSession)).toEqual([false, true, true, true, true])
  })
})
