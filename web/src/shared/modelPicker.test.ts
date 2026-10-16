import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import type { ModelStatus } from '@/native/model'
import { TAG_AI, hasAiChoices, tools } from '@/tools/registry'
import ModelPickerList from './ModelPickerList.vue'
import { L4_OPENAI_ID, type CatalogItem } from './aiCatalog'
import {
  MSG_DOWNLOADING,
  MSG_NOT_READY,
  buildDesc,
  buildItems,
  buildTitle,
  decideAction,
  formatMB,
  handlePick,
  readChoice,
  stateToStatus,
  writeChoice,
  type PickDeps,
  type PickerItem,
} from './modelPicker'

/** 构造一个清单状态 */
function st(state: ModelStatus['state'], downloaded = 0): ModelStatus {
  return { id: 'm', displayName: 'm', version: '1', state, totalBytes: 54662805, downloadedBytes: downloaded, diskBytes: downloaded }
}

/** 造一个目录项 */
function item(over: Partial<CatalogItem>): CatalogItem {
  return { key: 'm', layer: 'L1', title: '识物 SigLIP2', desc: '识别垃圾品类', status: 'ready', totalBytes: 54662805, downloadedBytes: 54662805, entries: {}, selectable: true, session: false, ...over }
}
/** 本地小模型项（有提供者） */
const L1 = item({ key: 'local-clip', providerId: 'local-clip', modelId: 'siglip2-mnn-w8' })
/** 本机 AI 项 */
const L3 = item({ key: 'intent-handoff', providerId: 'intent-handoff', layer: 'L3', title: '系统应用交接', desc: '摘要', totalBytes: 0, downloadedBytes: 0 })
/** L4 占位 */
const L4 = item({ key: L4_OPENAI_ID, layer: 'L4', title: 'OpenAI', desc: '在线模型', status: 'unsupported', totalBytes: 0, downloadedBytes: 0, selectable: false })

describe('状态映射', () => {
  it('五种原生状态', () => {
    expect(stateToStatus('installed')).toBe('ready')
    expect(stateToStatus('downloading')).toBe('loading')
    expect(stateToStatus('absent')).toBe('missing')
    expect(stateToStatus('unverified')).toBe('missing')
    expect(stateToStatus('corrupt')).toBe('missing')
    expect(stateToStatus(undefined)).toBe('unsupported')
  })
})

describe('文案', () => {
  it('标题「层名-模型名」', () => {
    expect(buildTitle('L1', 'OCR')).toBe('本地小模型-OCR')
    expect(buildTitle('L3', '系统应用交接')).toBe('本机AI-系统应用交接')
    expect(buildTitle('L4', 'OpenAI')).toBe('远端API-OpenAI')
  })
  it('备注含状态提示', () => {
    expect(formatMB(54662805)).toBe('54.7MB')
    expect(buildDesc('识别垃圾品类', 'ready', st('installed'))).toBe('识别垃圾品类 · 已安装 54.7MB')
    expect(buildDesc('x', 'missing')).toBe('x · 未下载，点击下载')
    expect(buildDesc('x', 'loading', st('downloading', 20224238))).toBe('x · 正在下载 37%')
    expect(buildDesc('x', 'unsupported')).toBe('未接入')
  })
})

describe('目录项转行', () => {
  it('标题带层名；选中且就绪的着色；本机 AI 备注写可用；占位未接入', () => {
    const items = buildItems([L1, L3, L4], 'local-clip')
    expect(items.map((i) => i.layer)).toEqual(['L1', 'L3', 'L4'])
    expect(items[0]).toMatchObject({ id: 'local-clip', modelId: 'siglip2-mnn-w8', status: 'selected', title: '本地小模型-识物 SigLIP2', desc: '识别垃圾品类 · 已安装 54.7MB' })
    expect(items[1]).toMatchObject({ status: 'ready', title: '本机AI-系统应用交接', desc: '摘要 · 可用' })
    expect(items[2]).toMatchObject({ id: L4_OPENAI_ID, status: 'unsupported', desc: '未接入' })
  })
  it('未下载、下载中按目录状态展示；选中但没装好的不着色', () => {
    const missing = buildItems([item({ key: 'local-qwen', layer: 'L2', title: 'Qwen', desc: '摘要', status: 'missing' })], 'local-qwen')[0]
    expect(missing).toMatchObject({ status: 'missing', title: '本地大模型-Qwen', desc: '摘要 · 未下载，点击下载' })
    const loading = buildItems([item({ status: 'loading', downloadedBytes: 20224238 })], null)[0]
    expect(loading).toMatchObject({ status: 'loading', desc: '识别垃圾品类 · 正在下载 37%' })
  })
  it('清单里查不到的过渡项显示未接入', () => {
    const items = buildItems([item({ key: 'model:ocr', modelId: 'ocr', status: 'unsupported', totalBytes: 0, downloadedBytes: 0 })], 'model:ocr')
    expect(items[0]).toMatchObject({ status: 'unsupported', desc: '未接入' })
  })
})

/** 造点击依赖 */
function deps(): PickDeps {
  return { select: vi.fn(), download: vi.fn().mockResolvedValue(undefined), notifyDownloading: vi.fn(), toast: vi.fn() }
}
/** 造一行 */
function row(status: PickerItem['status'], modelId?: string): PickerItem {
  return { id: 'm', modelId, layer: 'L1', title: 't', desc: 'd', status, progress: 0 }
}

describe('点击分支', () => {
  it('已下载：选中', async () => {
    const d = deps()
    expect(await handlePick(row('ready'), d)).toBe('select')
    expect(d.select).toHaveBeenCalledWith('m')
    expect(d.download).not.toHaveBeenCalled()
  })
  it('未下载：触发下载并提示', async () => {
    const d = deps()
    expect(await handlePick(row('missing'), d)).toBe('download')
    expect(d.download).toHaveBeenCalledWith('m')
    expect(d.notifyDownloading).toHaveBeenCalledTimes(1)
  })
  it('提供者项下载的是它的清单模型 id，不是提供者 id', async () => {
    const d = deps()
    await handlePick({ ...row('missing', 'qwen35-0.8b-mnn-q4'), id: 'local-qwen' }, d)
    expect(d.download).toHaveBeenCalledWith('qwen35-0.8b-mnn-q4')
  })
  it('下载中：只提示，不重复下载', async () => {
    const d = deps()
    expect(await handlePick(row('loading'), d)).toBe('notify')
    expect(d.download).not.toHaveBeenCalled()
    expect(d.notifyDownloading).toHaveBeenCalledTimes(1)
  })
  it('未接入：toast，不下载', async () => {
    const d = deps()
    expect(await handlePick(row('unsupported'), d)).toBe('toast')
    expect(d.toast).toHaveBeenCalledWith(MSG_NOT_READY)
    expect(d.download).not.toHaveBeenCalled()
    expect(decideAction(row('selected'))).toBe('select')
    expect(MSG_DOWNLOADING).toBe('正在下载，可以去AI中心查看')
  })
})

describe('选择结果', () => {
  /** 内存存储 */
  function mem(): Storage {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as Storage
  }
  it('读写与异常吞掉', () => {
    const s = mem()
    writeChoice('t', 'x', s)
    expect(readChoice('t', s)).toBe('x')
    const bad = {
      getItem: () => {
        throw new Error('x')
      },
      setItem: () => {
        throw new Error('x')
      },
    } as unknown as Storage
    expect(readChoice('t', bad)).toBeNull()
    expect(() => writeChoice('t', 'x', bad)).not.toThrow()
  })
})

describe('列表组件渲染', () => {
  it('各状态带对应 class，loading 有加载图标', async () => {
    const items = buildItems([item({ status: 'loading', downloadedBytes: 1000 }), item({ key: 'model:ocr', status: 'unsupported' })], null)
    const html = await renderToString(createSSRApp({ render: () => h(ModelPickerList, { items }) }))
    expect(html).toContain('mp__item--loading')
    expect(html).toContain('mp__item--unsupported')
    expect(html).toContain('本地小模型-识物 SigLIP2')
    const ready = await renderToString(
      createSSRApp({
        render: () => h(ModelPickerList, { items: buildItems([L1], 'local-clip') }),
      }),
    )
    expect(ready).toContain('mp__item--selected')
  })
})

describe('注册表', () => {
  it('带 ai 标签的工具都声明了任务或过渡清单模型', () => {
    const missing = tools.filter((t) => t.tags?.includes(TAG_AI) && !hasAiChoices(t)).map((t) => t.id)
    expect(missing).toEqual([])
  })
  it('没有 ai 标签的工具不出选择器', () => {
    expect(hasAiChoices(tools.find((t) => t.id === 'base64'))).toBe(false)
    expect(hasAiChoices(undefined)).toBe(false)
  })
})
