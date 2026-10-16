// 拍照翻译的执行流程：逐张 OCR，再逐块翻译；串行、可取消、单张失败不影响其它张。依赖都可注入，便于单测。
import { AiNotReadyError, isAiCancelled, type OcrResult, type TranslateParams, type TranslateResult } from '@/native/ai'
import { routeShort, PROVIDER_QWEN } from './shortInput'
import { translateErrorMessage } from './logic'
import { cancelProgress, finishOne, initProgress, usableBlocks, type PhotoBlockResult, type PhotoItemResult, type PhotoProgress } from './photoLogic'

/** 待处理的一张图 */
export interface PhotoInput {
  /** 图片名 */
  name: string
  /** 显示地址 */
  url: string
  /** 交给 OCR 的缓存路径 */
  path: string
}

/** 翻译一块文字所需的上下文（来自页面当前选择） */
export interface BlockTranslateCtx {
  /** 所选翻译提供者 id */
  provider: string
  /** 源语言码（可为 auto） */
  src: string
  /** 目标语言码 */
  tgt: string
  /** Qwen 是否就绪 */
  qwenReady: boolean
  /** Qwen 是否支持当前语言对 */
  qwenSupportsPair: boolean
  /** 改走 Qwen 时的回调（页面据此登记占用，离页卸载） */
  onUseQwen?: () => void
}

/** 流程依赖（页面接 native，测试注入假实现） */
export interface PhotoRunDeps {
  /** 对一张图做文字识别 */
  ocr: (path: string, signal: AbortSignal) => Promise<OcrResult>
  /** 调翻译 */
  translate: (params: TranslateParams, signal: AbortSignal) => Promise<TranslateResult>
}

/** 流程回调 */
export interface PhotoRunHooks {
  /** 某张结果有更新（含状态变化），给界面刷新 */
  onItem: (index: number, item: PhotoItemResult) => void
  /** 进度有更新 */
  onProgress: (p: PhotoProgress) => void
}

/** 流程终局 */
export interface PhotoRunOutcome {
  /** 最终进度 */
  progress: PhotoProgress
  /** 是否因模型未就绪而中止（页面据此重新探测目录并提示） */
  notReady: boolean
}

/**
 * 翻译一块文字：先走短语表/Qwen 路由（复用 {@link routeShort}），否则按所选提供者翻译。
 *
 * @param text 原文
 * @param ctx 页面当前选择
 * @param deps 翻译依赖
 * @param signal 取消信号
 * @returns 译文
 * @example const t = await translateBlock('你好', ctx, deps, ac.signal)
 */
export async function translateBlock(text: string, ctx: BlockTranslateCtx, deps: Pick<PhotoRunDeps, 'translate'>, signal: AbortSignal): Promise<string> {
  const route = routeShort({ provider: ctx.provider, text, src: ctx.src, tgt: ctx.tgt, qwenReady: ctx.qwenReady, qwenSupportsPair: ctx.qwenSupportsPair })
  if (route.kind === 'phrase') return route.text
  const useQwen = route.kind === 'qwen'
  if (useQwen) ctx.onUseQwen?.()
  const r = await deps.translate(
    { text, src: ctx.src as TranslateParams['src'], tgt: ctx.tgt as TranslateParams['tgt'], provider: useQwen ? PROVIDER_QWEN : ctx.provider },
    signal,
  )
  return r.text
}

/** 是不是「模型未就绪」类错误 */
function isNotReady(e: unknown): boolean {
  return e instanceof AiNotReadyError || (e as { code?: string } | null)?.code === 'NOT_READY'
}

/** 把单张处理失败转成人话 */
function failText(e: unknown): string {
  return translateErrorMessage(isNotReady(e) ? { code: 'NOT_READY' } : e)
}

/** 造一个取消错误，用于在块之间发现 signal 已触发时中断本张 */
function abortError(): Error {
  return Object.assign(new Error('cancelled'), { name: 'AbortError' })
}

/**
 * 依次处理多张图：串行 OCR + 逐块翻译。相同原文只翻一次；单块失败只标该块；单张失败只标该张；
 * 模型未就绪立即中止剩余；signal 触发后停止并把剩余标为已取消。
 *
 * @param images 待处理图片
 * @param ctx 翻译上下文
 * @param deps 依赖（OCR、翻译）
 * @param hooks 进度与结果回调
 * @param signal 取消信号
 * @returns 终局进度与是否因未就绪中止
 * @example const out = await runPhotoTranslate(imgs, ctx, deps, hooks, ac.signal)
 */
export async function runPhotoTranslate(images: PhotoInput[], ctx: BlockTranslateCtx, deps: PhotoRunDeps, hooks: PhotoRunHooks, signal: AbortSignal): Promise<PhotoRunOutcome> {
  let progress = initProgress(images.length)
  let notReady = false
  const cache = new Map<string, string>()
  hooks.onProgress(progress)

  for (let i = 0; i < images.length; i++) {
    const item: PhotoItemResult = { name: images[i].name, url: images[i].url, width: 0, height: 0, status: 'running', blocks: [] }
    if (signal.aborted || notReady) {
      hooks.onItem(i, { ...item, status: 'cancelled' })
      if (signal.aborted && !progress.cancelled) progress = cancelProgress(progress)
      continue
    }
    hooks.onItem(i, item)
    let ok = true
    try {
      const ocr = await deps.ocr(images[i].path, signal)
      item.width = ocr.width
      item.height = ocr.height
      for (const b of usableBlocks(ocr.blocks)) {
        if (signal.aborted) throw abortError()
        const res: PhotoBlockResult = { src: b.text, tgt: '', box: b.box }
        try {
          let t = cache.get(b.text)
          if (t === undefined) {
            t = await translateBlock(b.text, ctx, deps, signal)
            cache.set(b.text, t)
          }
          res.tgt = t
        } catch (e) {
          // 取消与未就绪要中断整张；其余只标这一块失败
          if (isAiCancelled(e) || isNotReady(e)) throw e
          res.failed = true
        }
        item.blocks.push(res)
        hooks.onItem(i, { ...item, blocks: [...item.blocks] })
      }
      item.status = 'done'
    } catch (e) {
      ok = false
      if (isAiCancelled(e)) {
        item.status = 'cancelled'
      } else {
        item.status = 'failed'
        item.error = failText(e)
        notReady = notReady || isNotReady(e)
      }
    }
    hooks.onItem(i, { ...item, blocks: [...item.blocks] })
    progress = item.status === 'cancelled' ? cancelProgress(progress) : finishOne(progress, ok)
    hooks.onProgress(progress)
  }
  return { progress, notReady }
}
