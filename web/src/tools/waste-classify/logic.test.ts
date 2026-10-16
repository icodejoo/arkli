import { describe, expect, it } from 'vitest'
import type { ImageClassifyResult } from '@/native/ai'
import {
  buildView,
  busyText,
  categoryMeta,
  CONFUSABLE_HINTS,
  classifyFailure,
  defaultSelection,
  HEAT_TIP_COUNT,
  matchHints,
  MAX_HINTS,
  percentText,
  QUEUE_HINT_MS,
  shouldWarnHeat,
  stageOf,
  UNCERTAIN_TEXT,
} from './logic'

/** 造一个识别结果 */
function result(over: Partial<ImageClassifyResult> = {}): ImageClassifyResult {
  return {
    items: [
      { id: 'milk_carton', nameZh: '牛奶利乐包', nameEn: 'milk carton', category: 'R', score: 0.2 },
      { id: 'paper_cup', nameZh: '纸杯', nameEn: 'paper cup', category: 'D', score: 0.1 },
      { id: 'leftover_drink', nameZh: '饮料残液', nameEn: 'leftover drink', category: 'W', score: 0.05 },
    ],
    categories: [
      { category: 'R', name: '可回收物', prob: 0.9 },
      { category: 'D', name: '干垃圾', prob: 0.07 },
      { category: 'W', name: '湿垃圾', prob: 0.03 },
    ],
    confidence: 0.9,
    uncertain: false,
    elapsedMs: 100,
    inferMs: 80,
    modelId: 'siglip2-mnn-w8',
    ...over,
  }
}

describe('categoryMeta / percentText', () => {
  it('四类有名字与颜色 token，未知给兜底', () => {
    expect(categoryMeta('R').name).toBe('可回收物')
    expect(categoryMeta('H').colorVar).toBe('--c-waste-h')
    expect(categoryMeta('W').name).toBe('湿垃圾')
    expect(categoryMeta('D').name).toBe('干垃圾')
    expect(categoryMeta('X').name).toBe('未知分类')
  })
  it('百分比夹紧并取整', () => {
    expect(percentText(0.874)).toBe('87%')
    expect(percentText(2)).toBe('100%')
    expect(percentText(-1)).toBe('0%')
    expect(percentText(NaN)).toBe('0%')
  })
})

describe('buildView', () => {
  it('拿得准：默认选第一个，顶部是它的分类与把握', () => {
    const r = result()
    expect(defaultSelection(r)).toBe(0)
    const v = buildView(r, 0)
    expect(v.headline).toMatchObject({ kind: 'done', title: '可回收物', sub: '把握 90%' })
    expect(v.cards[0].selected).toBe(true)
    expect(v.cards[0].bar).toBe(100)
    expect(v.cards[1].bar).toBe(50)
  })
  it('点别的候选：顶部分类随之改变，并说明按用户选的', () => {
    const v = buildView(result(), 1)
    expect(v.headline.title).toBe('干垃圾')
    expect(v.headline.category?.code).toBe('D')
    expect(v.headline.sub).toContain('按你选的「纸杯」')
    expect(v.headline.sub).toContain('7%')
    expect(v.cards.map((c) => c.selected)).toEqual([false, true, false])
  })
  it('拿不准：默认不预选，顶部不给结论', () => {
    const r = result({ uncertain: true, confidence: 0.5 })
    expect(defaultSelection(r)).toBe(-1)
    const v = buildView(r, -1)
    expect(v.headline).toMatchObject({ kind: 'pending', title: UNCERTAIN_TEXT, category: null })
    expect(v.cards.every((c) => !c.selected)).toBe(true)
  })
  it('拿不准时用户选了第一个：有结论，但不写「把握」', () => {
    const v = buildView(result({ uncertain: true }), 0)
    expect(v.headline.kind).toBe('done')
    expect(v.headline.sub).toContain('按你选的')
  })
  it('没有候选：不崩，给兜底话；分数全 0 时条为最小宽度', () => {
    expect(buildView(result({ items: [] }), -1).headline.kind).toBe('pending')
    expect(defaultSelection({ uncertain: false, items: [] })).toBe(-1)
    const zero = result()
    zero.items.forEach((i) => (i.score = 0))
    expect(buildView(zero, 0).cards[1].bar).toBe(4)
  })
})

describe('matchHints', () => {
  it('命中同组两个 id 才提示', () => {
    expect(matchHints([{ id: 'clean_cardboard_box' }, { id: 'greasy_takeout_food_container' }])[0]).toContain('油污')
    expect(matchHints([{ id: 'clean_cardboard_box' }, { id: 'milk_carton' }])).toEqual([])
  })
  it('最多 MAX_HINTS 条，且不改入参', () => {
    const items = [{ id: 'clean_cardboard_box' }, { id: 'greasy_takeout_food_container' }, { id: 'styrofoam_food_box' }]
    const out = matchHints(items)
    expect(out.length).toBeLessThanOrEqual(MAX_HINTS)
    expect(out.length).toBeGreaterThan(0)
    expect(items).toHaveLength(3)
  })
  it('可注入自定义表', () => {
    expect(matchHints([{ id: 'a' }, { id: 'b' }], [{ ids: ['a', 'b'], text: 'x' }])).toEqual(['x'])
  })
  it('提示表里的 id 都真的在词表里（防止词表改名后失效）', () => {
    const files = import.meta.glob('../../../../app/src/main/assets/ai/garbage_vocab.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const raw = Object.values(files)[0]
    expect(raw).toBeTruthy()
    const vocab = JSON.parse(raw) as { items: Array<{ id: string }> }
    const known = new Set(vocab.items.map((i) => i.id))
    for (const h of CONFUSABLE_HINTS) {
      expect(h.ids.length).toBeGreaterThanOrEqual(2)
      for (const id of h.ids) expect(known.has(id), id).toBe(true)
    }
  })
})

describe('stageOf', () => {
  it('只有已安装才就绪，其余都是未就绪', () => {
    expect(stageOf(false, 'installed')).toBe('noHost')
    expect(stageOf(true, 'installed')).toBe('ready')
    for (const s of ['absent', 'corrupt', 'unverified', 'downloading'] as const) expect(stageOf(true, s)).toBe('notReady')
  })
})

describe('classifyFailure / busyText / shouldWarnHeat', () => {
  it('NOT_READY 回下载引导，INTERNAL 说读不出来', () => {
    expect(classifyFailure({ name: 'AiNotReadyError' }).kind).toBe('notReady')
    expect(classifyFailure({ code: 'NOT_READY' }).kind).toBe('notReady')
    expect(classifyFailure({ code: 'INTERNAL' })).toEqual({ kind: 'toast', text: '这张图读不出来，换一张试试' })
    expect(classifyFailure({ code: 'BAD_PARAMS' }).kind).toBe('toast')
    expect(classifyFailure(null).kind).toBe('toast')
  })
  it('等久了提示排队', () => {
    expect(busyText(0)).toContain('正在看')
    expect(busyText(QUEUE_HINT_MS)).toContain('排队')
  })
  it('超过 20 次才提示发热', () => {
    expect(shouldWarnHeat(HEAT_TIP_COUNT)).toBe(false)
    expect(shouldWarnHeat(HEAT_TIP_COUNT + 1)).toBe(true)
  })
})
