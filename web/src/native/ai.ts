/**
 * 本地 AI 能力封装：OCR、超分、图像分类、人像抠图、人脸融合、黑白上色。
 * 对应原生 `native.ai.*`。模型运行时（sherpa-onnx + ort）由原生侧提供，页面只管调用与降级。
 *
 * 所有 `path` 都是缓存相对路径：页面先用 `writeBlobToCache` 写进去，
 * 结果路径用 {@link fetchAiResult} 以 `/files/<path>` 取回为 Blob。
 *
 * 没有宿主、原生返回 UNKNOWN_METHOD / NOT_READY、或 status 里该模型为 false 时，
 * 统一抛 {@link AiNotReadyError}，页面据此展示「模型未就绪」。
 */
import { call as bridgeCall, isNativeAvailable } from './bridge'

/** 原生调用函数形状，便于注入测试 */
export type CallFn = <T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<T>

/** 方法名常量 */
export const AI_METHODS = {
  status: 'native.ai.status',
  ocr: 'native.ai.ocr',
  upscale: 'native.ai.upscale',
  classify: 'native.ai.classify',
  matte: 'native.ai.matte',
  fuse: 'native.ai.fuse',
  colorize: 'native.ai.colorize',
} as const

/** 模型名 */
export type AiModel = 'ocr' | 'upscale' | 'classify' | 'matte' | 'fuse' | 'colorize'

/** 原生缓存路径在页面里的同源前缀 */
const FILES_URL_PREFIX = '/files/'
/** 推理耗时长，不设超时 */
const NO_TIMEOUT = { timeoutMs: 0 }
/** 分类默认返回条数 */
const DEFAULT_TOP_K = 5
/** 视为「未就绪」的原生错误码 */
const NOT_READY_CODES = ['UNKNOWN_METHOD', 'NOT_READY']

/** 各模型就绪状态 */
export interface AiStatus {
  /** 模型名 → 是否已就绪 */
  models: Record<AiModel, boolean>
}

/** OCR 文字块 */
export interface OcrBlock {
  /** 识别出的文字 */
  text: string
  /** 四点框 [x1,y1,x2,y2,x3,y3,x4,y4]，顺序为左上、右上、右下、左下，单位为原图像素 */
  box: number[]
  /** 置信度 0~1 */
  score: number
}

/** OCR 结果 */
export interface OcrResult {
  /** 文字块 */
  blocks: OcrBlock[]
  /** 原图宽 */
  width: number
  /** 原图高 */
  height: number
  /** 耗时毫秒 */
  elapsedMs: number
}

/** 带路径的图片结果 */
export interface AiImageResult {
  /** 结果缓存相对路径 */
  path: string
}

/** 超分结果 */
export interface UpscaleResult extends AiImageResult {
  /** 结果宽 */
  width: number
  /** 结果高 */
  height: number
}

/** 分类条目 */
export interface ClassifyItem {
  /** 标签（中文，由原生侧标签表给出） */
  label: string
  /** 置信度 0~1 */
  score: number
}

/** 模型未就绪错误 */
export class AiNotReadyError extends Error {
  /** 需要的模型 */
  readonly model: AiModel

  /**
   * @param model 需要的模型名
   */
  constructor(model: AiModel) {
    super('模型未就绪')
    this.name = 'AiNotReadyError'
    this.model = model
  }
}

/** 全部为 false 的状态 */
function emptyStatus(): AiStatus {
  return { models: { ocr: false, upscale: false, classify: false, matte: false, fuse: false, colorize: false } }
}

/** 判断是否是「未就绪」类原生错误 */
function isNotReadyError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return !!code && NOT_READY_CODES.indexOf(code) >= 0
}

/**
 * 查询各 AI 模型是否就绪。
 *
 * 无宿主或原生返回 UNKNOWN_METHOD / NOT_READY 时视为全部未就绪；其他错误照常抛出。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 各模型就绪状态
 * @example const { models } = await getAiStatus(); if (!models.ocr) showGap()
 */
export async function getAiStatus(call: CallFn = bridgeCall): Promise<AiStatus> {
  if (!isNativeAvailable()) return emptyStatus()
  try {
    const res = await call<Partial<AiStatus>>(AI_METHODS.status, {})
    return { models: { ...emptyStatus().models, ...(res?.models ?? {}) } }
  } catch (e) {
    if (isNotReadyError(e)) return emptyStatus()
    throw e
  }
}

/** 先查 status，再调用；任何「未就绪」都统一成 AiNotReadyError */
async function invoke<T>(model: AiModel, method: string, params: Record<string, unknown>, call: CallFn): Promise<T> {
  if (!isNativeAvailable()) throw new AiNotReadyError(model)
  const status = await getAiStatus(call)
  if (!status.models[model]) throw new AiNotReadyError(model)
  try {
    return await call<T>(method, params, NO_TIMEOUT)
  } catch (e) {
    if (isNotReadyError(e)) throw new AiNotReadyError(model)
    throw e
  }
}

/**
 * 文字识别。
 *
 * @param path 图片缓存相对路径
 * @param lang 语言，默认 zh
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 文字块与原图尺寸
 * @throws AiNotReadyError 模型未就绪
 * @example const r = await aiOcr('cache/out/a.jpg')
 */
export function aiOcr(path: string, lang: 'zh' | 'en' = 'zh', call: CallFn = bridgeCall): Promise<OcrResult> {
  return invoke<OcrResult>('ocr', AI_METHODS.ocr, { path, lang }, call)
}

/**
 * 图像超分。
 *
 * @param path 图片缓存相对路径
 * @param scale 放大倍数
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 结果路径与尺寸
 * @throws AiNotReadyError 模型未就绪
 * @example const r = await aiUpscale(path, 2)
 */
export function aiUpscale(path: string, scale: 2 | 4, call: CallFn = bridgeCall): Promise<UpscaleResult> {
  return invoke<UpscaleResult>('upscale', AI_METHODS.upscale, { path, scale }, call)
}

/**
 * 图像分类。
 *
 * @param path 图片缓存相对路径
 * @param topK 返回前几名，默认 5
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 分类条目（按分数降序）
 * @throws AiNotReadyError 模型未就绪
 * @example const { items } = await aiClassify(path, 3)
 */
export function aiClassify(path: string, topK: number = DEFAULT_TOP_K, call: CallFn = bridgeCall): Promise<{ items: ClassifyItem[] }> {
  return invoke<{ items: ClassifyItem[] }>('classify', AI_METHODS.classify, { path, topK }, call)
}

/**
 * 人像抠图，结果是带 alpha 的 PNG。
 *
 * @param path 图片缓存相对路径
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 结果路径
 * @throws AiNotReadyError 模型未就绪
 * @example const { path: out } = await aiMatte(path)
 */
export function aiMatte(path: string, call: CallFn = bridgeCall): Promise<AiImageResult> {
  return invoke<AiImageResult>('matte', AI_METHODS.matte, { path }, call)
}

/**
 * 人脸融合。
 *
 * @param pathA 图 A 缓存相对路径
 * @param pathB 图 B 缓存相对路径
 * @param ratio 融合比例 0~1，缺省由原生决定（一般 0.5）
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 结果路径
 * @throws AiNotReadyError 模型未就绪
 * @example const { path } = await aiFuse(a, b, 0.4)
 */
export function aiFuse(pathA: string, pathB: string, ratio?: number, call: CallFn = bridgeCall): Promise<AiImageResult> {
  const params: Record<string, unknown> = { pathA, pathB }
  if (ratio !== undefined) params.ratio = ratio
  return invoke<AiImageResult>('fuse', AI_METHODS.fuse, params, call)
}

/**
 * 黑白照片上色。
 *
 * @param path 图片缓存相对路径
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 结果路径
 * @throws AiNotReadyError 模型未就绪
 * @example const { path: out } = await aiColorize(path)
 */
export function aiColorize(path: string, call: CallFn = bridgeCall): Promise<AiImageResult> {
  return invoke<AiImageResult>('colorize', AI_METHODS.colorize, { path }, call)
}

/**
 * 把原生结果路径取回为 Blob（走同源 `/files/<path>`）。
 *
 * @param path 结果缓存相对路径
 * @param fetchFn 取数函数，默认全局 fetch（仅测试注入）
 * @returns 结果内容
 * @throws Error 取回失败
 * @example const blob = await fetchAiResult(res.path)
 */
export async function fetchAiResult(path: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<Blob> {
  const res = await fetchFn(FILES_URL_PREFIX + path)
  if (!res.ok) throw new Error('读取结果失败')
  return res.blob()
}
