import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import type { ModelStatus } from '@/native/model'
import { TAG_AI, tools, type ToolModelOption } from '@/tools/registry'
import ModelPickerList from './ModelPickerList.vue'
import {
  L4_OPENAI_ID,
  MSG_DOWNLOADING,
  MSG_NOT_READY,
  buildDesc,
  buildItems,
  buildTitle,
  decideAction,
  filterLayers,
  formatMB,
  handlePick,
  readChoice,
  resolveChoice,
  stateToStatus,
  writeChoice,
  type PickDeps,
  type PickerItem,
} from './modelPicker'

/** 构造一个清单状态 */
function st(state: ModelStatus['state'], downloaded = 0): ModelStatus {
  return { id: 'm', displayName: 'm', version: '1', state, totalBytes: 54662805, downloadedBytes: downloaded, diskBytes: downloaded }
}

const L1: ToolModelOption = { layer: 'L1', modelId: 'm', title: '识物 SigLIP2', desc: '识别垃圾品类' }
const L3: ToolModelOption = { layer: 'L3', modelId: 'intent-handoff', title: '系统应用交接', desc: '交给系统应用' }

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

describe('层过滤与构建', () => {
  it('L3 提供者不可用就隐藏', () => {
    expect(filterLayers([L1, L3], [])).toEqual([L1])
    expect(filterLayers([L1, L3], ['intent-handoff'])).toEqual([L1, L3])
  })
  it('L2/L4 占位总在，置灰未接入；选中着色', () => {
    const items = buildItems([L1, L3], { statuses: { m: st('installed') }, providerIds: ['intent-handoff'], selected: 'm' })
    expect(items.map((i) => i.layer)).toEqual(['L1', 'L2', 'L3', 'L4'])
    expect(items[0]).toMatchObject({ status: 'selected', title: '本地小模型-识物 SigLIP2' })
    expect(items[1].status).toBe('unsupported')
    expect(items[2].status).toBe('ready')
    expect(items[3]).toMatchObject({ id: L4_OPENAI_ID, desc: '未接入' })
  })
  it('清单里查不到的 L1 显示未接入', () => {
    const items = buildItems([L1], { statuses: {}, providerIds: [], selected: null })
    expect(items[0]).toMatchObject({ status: 'unsupported', desc: '未接入' })
  })
})

/** 造点击依赖 */
function deps(): PickDeps {
  return { select: vi.fn(), download: vi.fn().mockResolvedValue(undefined), notifyDownloading: vi.fn(), toast: vi.fn() }
}
/** 造一行 */
function row(status: PickerItem['status']): PickerItem {
  return { id: 'm', layer: 'L1', title: 't', desc: 'd', status, progress: 0 }
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
  it('默认第一个 L1；存值有效则用存值；失效回落', () => {
    const a: ToolModelOption = { ...L1, modelId: 'a' }
    expect(resolveChoice(null, [a, L1])).toBe('a')
    expect(resolveChoice('m', [a, L1])).toBe('m')
    expect(resolveChoice('gone', [a, L1])).toBe('a')
    expect(resolveChoice(null, [])).toBeNull()
  })
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
    const items = buildItems([L1], { statuses: { m: st('downloading', 1000) }, providerIds: [], selected: null })
    const html = await renderToString(createSSRApp({ render: () => h(ModelPickerList, { items }) }))
    expect(html).toContain('mp__item--loading')
    expect(html).toContain('mp__item--unsupported')
    expect(html).toContain('本地小模型-识物 SigLIP2')
    const ready = await renderToString(
      createSSRApp({
        render: () => h(ModelPickerList, { items: buildItems([L1], { statuses: { m: st('installed') }, providerIds: [], selected: 'm' }) }),
      }),
    )
    expect(ready).toContain('mp__item--selected')
  })
})

describe('注册表', () => {
  it('带 ai 标签的工具都声明了可选模型', () => {
    const missing = tools.filter((t) => t.tags?.includes(TAG_AI) && !t.models?.length).map((t) => t.id)
    expect(missing).toEqual([])
  })
})
