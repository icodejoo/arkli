import { describe, expect, it, vi } from 'vitest'
import type { LogoSymbolResult } from '@/native/ai'
import {
  BUSY_RETRY_MAX,
  GATE_WARN_TEXT,
  isBusyError,
  layoutAt,
  needTemplateFallback,
  paramsFromSymbol,
  parseSymbolPaths,
  progressText,
  reasonText,
  runSymbolBatch,
  sortCandidates,
  toCandidate,
  type GenerateOne,
  type SymbolCandidate,
} from './symbol'
import { renderLogoSvg } from './render'

/** 一段真实形状的原生输出（两条 path，带 vtracer 平移） */
const SVG = '<path d="M0 0 C1.5 0 2.5 1 3 2 L10 10 Z" fill="#000000" transform="translate(250.5,68.875)"/><path d="M0 0 L5 0 L5 5 Z" fill="#000000" transform="translate(100,205)"/>'

/** 造一条原生结果 */
function native(over: Partial<LogoSymbolResult> = {}): LogoSymbolResult {
  return { svgPaths: SVG, pathCount: 2, gateOk: true, gateReasons: [], seed: 7, residency: 'resident', elapsedMs: 8000, modelId: 'sdxs512-mnn-w8', ...over }
}

/** 造一个候选 */
function cand(concept: string, gateOk: boolean): SymbolCandidate {
  return { concept, seed: 1, gateOk, reasons: gateOk ? [] : ['fragments'], paths: [{ d: 'M0 0 L1 1 Z', tx: 0, ty: 0 }], elapsedMs: 1 }
}

describe('parseSymbolPaths', () => {
  it('解析 d 与 translate，坐标系按 512 处理', () => {
    expect(parseSymbolPaths(SVG)).toEqual([
      { d: 'M0 0 C1.5 0 2.5 1 3 2 L10 10 Z', tx: 250.5, ty: 68.875 },
      { d: 'M0 0 L5 0 L5 5 Z', tx: 100, ty: 205 },
    ])
  })
  it('没有 transform 时平移为 0；支持逗号与空格分隔、科学计数', () => {
    expect(parseSymbolPaths('<path d="M0 0 Z" fill="#000000"/>')).toEqual([{ d: 'M0 0 Z', tx: 0, ty: 0 }])
    expect(parseSymbolPaths('<path d="M0 0 Z" transform="translate(1e1 -2.5)"/>')[0]).toMatchObject({ tx: 10, ty: -2.5 })
  })
  it('空、null、没有 path 都给空数组', () => {
    expect(parseSymbolPaths(null)).toEqual([])
    expect(parseSymbolPaths('')).toEqual([])
    expect(parseSymbolPaths('<g/>')).toEqual([])
  })
  it('d 里有非路径字符（脚本注入）的整条丢弃，正常的保留', () => {
    const bad = '<path d="M0 0 <script> Z" fill="#000000"/>'
    expect(parseSymbolPaths(bad + '<path d="M1 1 Z"/>')).toEqual([{ d: 'M1 1 Z', tx: 0, ty: 0 }])
  })
  it('条数有上限', () => {
    const many = '<path d="M0 0 Z"/>'.repeat(500)
    expect(parseSymbolPaths(many).length).toBe(400)
  })
})

describe('toCandidate', () => {
  it('带上概念、种子、闸门结果；空图为 null', () => {
    const c = toCandidate('a dumbbell', native({ gateOk: false, gateReasons: ['fragments', 'specks'] }))
    expect(c).toMatchObject({ concept: 'a dumbbell', seed: 7, gateOk: false, reasons: ['fragments', 'specks'], elapsedMs: 8000 })
    expect(c?.paths).toHaveLength(2)
    expect(toCandidate('x', native({ svgPaths: null, pathCount: 0 }))).toBeNull()
  })
})

describe('闸门排序与补位', () => {
  it('过闸的排前面，组内保持生成顺序，不改入参', () => {
    const list = [cand('a', false), cand('b', true), cand('c', false), cand('d', true)]
    expect(sortCandidates(list).map((c) => c.concept)).toEqual(['b', 'd', 'a', 'c'])
    expect(list.map((c) => c.concept)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('一张过闸的都没有（含没出图）才需要补模板方案', () => {
    expect(needTemplateFallback([])).toBe(true)
    expect(needTemplateFallback([cand('a', false), cand('b', false), cand('c', false), cand('d', false)])).toBe(true)
    expect(needTemplateFallback([cand('a', false), cand('b', true)])).toBe(false)
  })
  it('原因转中文，未知码原样保留；提示文案是“效果可能欠佳”', () => {
    expect(reasonText(['fragments', 'specks'])).toBe('图形太碎、杂点太多')
    expect(reasonText(['zzz'])).toBe('zzz')
    expect(reasonText([])).toBe('')
    expect(GATE_WARN_TEXT).toBe('效果可能欠佳')
  })
})

describe('版式与参数', () => {
  it('四种版式轮流，负数也稳', () => {
    expect([0, 1, 2, 3, 4].map(layoutAt)).toEqual(['ai-ring', 'ai-solid', 'ai-square', 'ai-lockup', 'ai-ring'])
    expect(layoutAt(-1)).toBe('ai-lockup')
  })
  it('paramsFromSymbol：带 symbol、图标清空、配色字体取方案、名字裁剪', () => {
    const p = paramsFromSymbol(cand('a', true), { template: 'stack', palette: 'tech-blue', icon: 'coffee', font: 'serif' }, { name: ' 山屿 ', slogan: '', desc: '' }, 2)
    expect(p).toMatchObject({ palette: 'tech-blue', font: 'serif', icon: '', name: '山屿' })
    expect(p.symbol).toMatchObject({ layout: 'ai-square', vb: 512 })
    expect(renderLogoSvg(p)).toContain('<g transform=')
  })
  it('进度文案', () => {
    expect(progressText(0, 4)).toBe('第 1/4 张')
    expect(progressText(3, 4)).toBe('第 4/4 张')
    expect(progressText(4, 4)).toBe('第 4/4 张')
  })
})

describe('runSymbolBatch', () => {
  /** 按调用顺序返回不同结果的假生成函数 */
  function fakeGen(results: Array<LogoSymbolResult | Error>): ReturnType<typeof vi.fn<GenerateOne>> {
    const fn = vi.fn<GenerateOne>()
    results.forEach((r) => (r instanceof Error ? fn.mockRejectedValueOnce(r) : fn.mockResolvedValueOnce(r)))
    return fn
  }
  const cancelled = () => Object.assign(new Error('cancelled'), { code: 'CANCELLED' })
  const busy = () => Object.assign(new Error('正在生成，请稍候'), { code: 'INTERNAL' })
  const noSleep = async () => undefined

  it('4 个概念依次出 4 张，逐张回调并报进度，种子逐张不同', async () => {
    const gen = fakeGen([native(), native(), native(), native()])
    let n = 0
    const progress: Array<[number, number]> = []
    const got: Array<string | undefined> = []
    const r = await runSymbolBatch(['a', 'b', 'c', 'd'], gen, { seed: () => ++n, onProgress: (d, t) => progress.push([d, t]), onItem: (c) => got.push(c?.concept) })
    expect(r.items.map((c) => c.concept)).toEqual(['a', 'b', 'c', 'd'])
    expect(r.cancelled).toBe(false)
    expect(progress).toEqual([[0, 4], [1, 4], [2, 4], [3, 4]])
    expect(got).toEqual(['a', 'b', 'c', 'd'])
    expect(gen.mock.calls.map((c) => c[1])).toEqual([1, 2, 3, 4])
  })
  it('取消：停止后续张，已出的保留', async () => {
    const gen = fakeGen([native(), cancelled()])
    const r = await runSymbolBatch(['a', 'b', 'c', 'd'], gen)
    expect(r.cancelled).toBe(true)
    expect(r.items.map((c) => c.concept)).toEqual(['a'])
    expect(gen).toHaveBeenCalledTimes(2)
  })
  it('取消信号在两张之间触发：不再发起下一张', async () => {
    const ac = new AbortController()
    const gen = vi.fn<GenerateOne>().mockImplementation(async () => {
      ac.abort()
      return native()
    })
    const r = await runSymbolBatch(['a', 'b', 'c'], gen, { signal: ac.signal })
    expect(r.cancelled).toBe(true)
    expect(r.items).toHaveLength(1)
    expect(gen).toHaveBeenCalledTimes(1)
  })
  it('空图不进结果但仍回调（candidate 为 null）', async () => {
    const seen: Array<unknown> = []
    const r = await runSymbolBatch(['a', 'b'], fakeGen([native({ svgPaths: null }), native()]), { onItem: (c) => seen.push(c) })
    expect(r.items.map((c) => c.concept)).toEqual(['b'])
    expect(seen[0]).toBeNull()
  })
  it('并发拒绝（取消后原生还在收尾）：等一会儿重试成功', async () => {
    const sleep = vi.fn(noSleep)
    const r = await runSymbolBatch(['a'], fakeGen([busy(), busy(), native()]), { sleep })
    expect(r.items).toHaveLength(1)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
  it('一直被拒：超过重试上限后带着错误停止', async () => {
    const gen = vi.fn<GenerateOne>().mockRejectedValue(busy())
    const r = await runSymbolBatch(['a'], gen, { sleep: noSleep })
    expect(r.error).toBeDefined()
    expect(gen).toHaveBeenCalledTimes(BUSY_RETRY_MAX + 1)
  })
  it('其它错误：停止后续张，已出的保留并带回错误', async () => {
    const boom = Object.assign(new Error('x'), { code: 'NOT_READY' })
    const r = await runSymbolBatch(['a', 'b', 'c'], fakeGen([native(), boom]))
    expect(r.items).toHaveLength(1)
    expect(r.error).toBe(boom)
    expect(r.cancelled).toBe(false)
  })
  it('重试等待期间取消：不再重试', async () => {
    const ac = new AbortController()
    const gen = vi.fn<GenerateOne>().mockRejectedValue(busy())
    const r = await runSymbolBatch(['a'], gen, { signal: ac.signal, sleep: async () => ac.abort() })
    expect(r.cancelled).toBe(true)
    expect(gen).toHaveBeenCalledTimes(1)
  })
  it('isBusyError 只认“正在生成”', () => {
    expect(isBusyError(busy())).toBe(true)
    expect(isBusyError(new Error('别的'))).toBe(false)
    expect(isBusyError(null)).toBe(false)
  })
})
