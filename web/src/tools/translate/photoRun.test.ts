import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { OcrResult, TranslateParams } from '@/native/ai'
import type { BlockTranslateCtx, PhotoInput, PhotoRunDeps } from './photoRun'
import type { PhotoItemResult, PhotoProgress } from './photoLogic'

// bridge 在导入时读 window：先桩掉再动态导入
let AiNotReadyError: typeof import('@/native/ai').AiNotReadyError
let runPhotoTranslate: typeof import('./photoRun').runPhotoTranslate
let translateBlock: typeof import('./photoRun').translateBlock

beforeAll(async () => {
  vi.stubGlobal('window', {})
  ;({ AiNotReadyError } = await import('@/native/ai'))
  ;({ runPhotoTranslate, translateBlock } = await import('./photoRun'))
})

const ctx: BlockTranslateCtx = { provider: 'local-nllb', src: 'en', tgt: 'zh-CN', qwenReady: false, qwenSupportsPair: false }
const imgs = (n: number): PhotoInput[] => Array.from({ length: n }, (_, i) => ({ name: `${i}.jpg`, url: `u${i}`, path: `p${i}` }))
const ocrOf = (...texts: string[]): OcrResult => ({
  width: 100,
  height: 50,
  elapsedMs: 1,
  blocks: texts.map((text, i) => ({ text, box: [0, i, 10, i, 10, i + 5, 0, i + 5], score: 1 })),
})
const tr = (p: TranslateParams) => ({ text: `T(${p.text})`, elapsedMs: 1, modelId: 'm', src: p.src, tgt: p.tgt, detectedSrc: [], unrecognized: false })

/** 跑一遍并收集回调 */
async function run(deps: PhotoRunDeps, n: number, c: BlockTranslateCtx = ctx, signal = new AbortController().signal) {
  const items: PhotoItemResult[] = []
  const progress: PhotoProgress[] = []
  const out = await runPhotoTranslate(imgs(n), c, deps, { onItem: (i, it) => (items[i] = it), onProgress: (p) => progress.push(p) }, signal)
  return { items, progress, out }
}

describe('translateBlock', () => {
  it('极短且命中短语表：不调翻译', async () => {
    const translate = vi.fn()
    expect(await translateBlock('你好', { ...ctx, src: 'zh-CN', tgt: 'en' }, { translate }, new AbortController().signal)).toBeTruthy()
    expect(translate).not.toHaveBeenCalled()
  })
  it('极短未命中且 Qwen 就绪：改走 Qwen 并回调', async () => {
    const translate = vi.fn(async (p: TranslateParams) => tr(p))
    const onUseQwen = vi.fn()
    await translateBlock('qzx', { ...ctx, qwenReady: true, qwenSupportsPair: true, onUseQwen }, { translate }, new AbortController().signal)
    expect(translate.mock.calls[0][0].provider).toBe('local-qwen')
    expect(onUseQwen).toHaveBeenCalledOnce()
  })
  it('普通文本用所选提供者', async () => {
    const translate = vi.fn(async (p: TranslateParams) => tr(p))
    expect(await translateBlock('a long sentence here', ctx, { translate }, new AbortController().signal)).toBe('T(a long sentence here)')
    expect(translate.mock.calls[0][0].provider).toBe('local-nllb')
  })
})

describe('runPhotoTranslate', () => {
  it('串行处理多张，相同原文只翻一次', async () => {
    let active = 0
    let maxActive = 0
    const translate = vi.fn(async (p: TranslateParams) => {
      maxActive = Math.max(maxActive, ++active)
      await Promise.resolve()
      active--
      return tr(p)
    })
    const ocr = vi.fn(async () => ocrOf('hello there world', 'hello there world', 'another line of text'))
    const { items, out } = await run({ ocr, translate }, 2)
    expect(maxActive).toBe(1)
    expect(translate).toHaveBeenCalledTimes(2)
    expect(items.map((i) => i.status)).toEqual(['done', 'done'])
    expect(items[0].blocks.map((b) => b.tgt)).toEqual(['T(hello there world)', 'T(hello there world)', 'T(another line of text)'])
    expect(out.progress).toMatchObject({ finished: 2, failed: 0, current: -1 })
    expect(out.notReady).toBe(false)
  })
  it('单张 OCR 失败不影响其它张', async () => {
    const ocr = vi.fn(async (path: string) => {
      if (path === 'p0') throw Object.assign(new Error('x'), { code: 'INTERNAL' })
      return ocrOf('some words in line')
    })
    const { items, out } = await run({ ocr, translate: async (p) => tr(p) }, 2)
    expect(items.map((i) => i.status)).toEqual(['failed', 'done'])
    expect(items[0].error).toBeTruthy()
    expect(out.progress).toMatchObject({ finished: 2, failed: 1 })
  })
  it('单块翻译失败只标该块', async () => {
    const translate = vi.fn(async (p: TranslateParams) => {
      if (p.text.startsWith('bad')) throw Object.assign(new Error('x'), { code: 'INTERNAL' })
      return tr(p)
    })
    const { items } = await run({ ocr: async () => ocrOf('bad block text', 'good block text'), translate }, 1)
    expect(items[0].status).toBe('done')
    expect(items[0].blocks.map((b) => !!b.failed)).toEqual([true, false])
  })
  it('模型未就绪：中止剩余并标记 notReady', async () => {
    const ocr = vi.fn(async () => {
      throw new AiNotReadyError('ocr')
    })
    const { items, out } = await run({ ocr, translate: async (p) => tr(p) }, 3)
    expect(ocr).toHaveBeenCalledOnce()
    expect(items.map((i) => i.status)).toEqual(['failed', 'cancelled', 'cancelled'])
    expect(out.notReady).toBe(true)
  })
  it('中途取消：当前块之后停止，其余标已取消', async () => {
    const ac = new AbortController()
    const translate = vi.fn(async (p: TranslateParams) => {
      ac.abort()
      return tr(p)
    })
    const { items, out } = await run({ ocr: async () => ocrOf('first line text', 'second line text'), translate }, 3, ctx, ac.signal)
    expect(translate).toHaveBeenCalledOnce()
    expect(items.map((i) => i.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(items[0].blocks).toHaveLength(1)
    expect(out.progress.cancelled).toBe(true)
  })
  it('开始前已取消：一张都不处理', async () => {
    const ac = new AbortController()
    ac.abort()
    const ocr = vi.fn()
    const { out } = await run({ ocr, translate: async (p) => tr(p) }, 2, ctx, ac.signal)
    expect(ocr).not.toHaveBeenCalled()
    expect(out.progress).toMatchObject({ cancelled: true, finished: 0 })
  })
  it('没识别到文字：成功且无块', async () => {
    const { items } = await run({ ocr: async () => ocrOf(), translate: async (p) => tr(p) }, 1)
    expect(items[0]).toMatchObject({ status: 'done', blocks: [] })
  })
})
