/**
 * 本地 AI 能力封装：OCR、超分、人像抠图、人脸融合、黑白上色。
 * 对应原生 `native.ai.*`。模型运行时（sherpa-onnx + ort）由原生侧提供，页面只管调用与降级。
 *
 * 所有 `path` 都是缓存相对路径：页面先用 `writeBlobToCache` 写进去，
 * 结果路径用 {@link fetchAiResult} 以 `/files/<path>` 取回为 Blob。
 *
 * 没有宿主、原生返回 UNKNOWN_METHOD / NOT_READY、或 status 里该模型为 false 时，
 * 统一抛 {@link AiNotReadyError}，页面据此展示「模型未就绪」。
 */
import { call as bridgeCall, isNativeAvailable, type CallOptions } from './bridge'
import { NativeUnavailableError } from './system'

/** 原生调用函数形状，便于注入测试 */
export type CallFn = <T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<T>

/** 方法名常量 */
export const AI_METHODS = {
  status: 'native.ai.status',
  providers: 'native.ai.providers',
  run: 'native.ai.run',
  ocr: 'native.ai.ocr',
  upscale: 'native.ai.upscale',
  classify: 'native.ai.classify',
  matte: 'native.ai.matte',
  fuse: 'native.ai.fuse',
  colorize: 'native.ai.colorize',
  translate: 'native.ai.translate',
  warmup: 'native.ai.warmup',
  unload: 'native.ai.unload',
} as const

/** 模型名 */
export type AiModel = 'ocr' | 'upscale' | 'classify' | 'matte' | 'fuse' | 'colorize'

/** 原生缓存路径在页面里的同源前缀 */
const FILES_URL_PREFIX = '/files/'
/** 推理耗时长，不设超时 */
const NO_TIMEOUT = { timeoutMs: 0 }
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

/** 识物（本地 SigLIP2）的一个候选物品 */
export interface ImageClassifyItem {
  /** 词表里的稳定 id，如 `milk_carton` */
  id: string
  /** 中文名 */
  nameZh: string
  /** 英文名 */
  nameEn: string
  /** 分类代码：R 可回收物 / H 有害垃圾 / W 湿垃圾 / D 干垃圾（草稿，待核对） */
  category: string
  /** 与图像的余弦相似度，4 位小数 */
  score: number
}

/** 识物的分类聚合概率 */
export interface ImageClassifyCategory {
  /** 分类代码 */
  category: string
  /** 分类中文名，如「可回收物」 */
  name: string
  /** 聚合概率 0~1 */
  prob: number
}

/** `native.ai.classify` 的结果 */
export interface ImageClassifyResult {
  /** top-k 物品，按余弦相似度降序 */
  items: ImageClassifyItem[]
  /** 各分类聚合概率，降序 */
  categories: ImageClassifyCategory[]
  /** 最大分类概率 */
  confidence: number
  /** 置信度低于 0.8，应提示「拿不准」 */
  uncertain: boolean
  /** 总耗时毫秒（含解码） */
  elapsedMs: number
  /** 其中推理部分毫秒 */
  inferMs: number
  /** 模型标识，如 `siglip2-q4_half` */
  modelId: string
}

/** 识物默认返回条数 */
const DEFAULT_IMAGE_TOP_K = 3

/**
 * 本地识物（垃圾分类，SigLIP2 q4_half）：对一张缓存图片给出 top-k 物品与分类概率。
 *
 * 不看 `native.ai.status`（它仍是占位），直接调用；模型文件不在时原生返回 NOT_READY，这里统一成
 * {@link AiNotReadyError}。图片解码、EXIF 摆正、缩放都在原生与 Rust 里完成。
 *
 * @param path 图片缓存相对路径，如 `cache/pick/a.jpg`
 * @param topK 返回前几名，1~10，默认 3
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 识别结果
 * @throws AiNotReadyError 无宿主、方法不存在或模型未就绪
 * @example const r = await aiClassifyImage(path); if (r.uncertain) tip('拿不准')
 */
export async function aiClassifyImage(path: string, topK: number = DEFAULT_IMAGE_TOP_K, call: CallFn = bridgeCall): Promise<ImageClassifyResult> {
  if (!isNativeAvailable()) throw new AiNotReadyError('classify')
  try {
    return await call<ImageClassifyResult>(AI_METHODS.classify, { path, topK }, NO_TIMEOUT)
  } catch (e) {
    if (isNotReadyError(e)) throw new AiNotReadyError('classify')
    throw e
  }
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

/** AI 任务：页面只认任务，不认厂商 */
export type AiTask = 'summarize' | 'proofread' | 'rewrite' | 'describeImage' | 'prompt' | 'translate' | 'classifyImage'

/** 提供者不可用的原因（未知值按字符串透传，页面不认识就当「不可用」） */
export type AiUnavailableReason = 'no_handler' | 'unsupported_device' | 'not_installed' | 'not_configured' | (string & {})

/** 一个 AI 提供者 */
export interface AiProviderInfo {
  /** 稳定标识，如 `intent-handoff` */
  id: string
  /** 展示名 */
  displayName: string
  /** 当前是否可用 */
  available: boolean
  /** 不可用时的原因 */
  reason?: AiUnavailableReason
  /** 支持的任务 */
  tasks: AiTask[]
  /** 本地模型类提供者才有：清单里的模型 id，对应 `native.model.*` */
  modelId?: string
  /** 本地模型类提供者才有：模型已安装且 sha256 校验通过 */
  downloaded?: boolean
  /** 本地模型类提供者才有：磁盘占用字节（含未完成的 .part） */
  sizeBytes?: number
  /** 本地模型类提供者才有：是否正在下载或校验 */
  downloading?: boolean
}

/** `native.ai.providers` 的结果 */
export interface AiProviders {
  /** 全部提供者，含不可用的 */
  providers: AiProviderInfo[]
  /** 可用提供者支持的任务并集 */
  capabilities: AiTask[]
}

/** `native.ai.run` 的结果 */
export interface AiRunResult {
  /** 是否只是把输入交给了别的应用（拿不回结果） */
  handoff: boolean
  /** 是否真的有应用接手；非交接时恒为 true */
  handled: boolean
  /** 直接结果文本，仅非交接时有 */
  text?: string
}

/** 提供者 id：把文本交给系统里已有的应用 */
export const HANDOFF_PROVIDER_ID = 'intent-handoff'

/** 空的提供者结果：无宿主或原生没有该方法时使用 */
function emptyProviders(): AiProviders {
  return { providers: [], capabilities: [] }
}

/**
 * 探测有哪些 AI 提供者可用，页面据此决定显示或隐藏入口。
 *
 * 无宿主或原生返回 UNKNOWN_METHOD 时视为没有任何提供者；其他错误照常抛出。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 提供者列表与可用任务并集
 * @example const { capabilities } = await aiProviders(); if (capabilities.includes('translate')) showButton()
 */
export async function aiProviders(call: CallFn = bridgeCall): Promise<AiProviders> {
  if (!isNativeAvailable()) return emptyProviders()
  try {
    const res = await call<Partial<AiProviders>>(AI_METHODS.providers, {})
    return { providers: res?.providers ?? [], capabilities: res?.capabilities ?? [] }
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'UNKNOWN_METHOD') return emptyProviders()
    throw e
  }
}

/**
 * 让某个提供者执行任务。交接类提供者只是把文本交给系统里的其他应用，拿不回结果。
 *
 * @param provider 提供者 id，如 {@link HANDOFF_PROVIDER_ID}
 * @param task 任务
 * @param input 输入文本，1~5 万字符
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 交接标记或直接结果
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @throws 原生错误 BAD_PARAMS（参数或提供者不对）、NOT_READY（提供者当前不可用）
 * @example const r = await aiRun(HANDOFF_PROVIDER_ID, 'translate', 'hello'); if (r.handoff && !r.handled) tip('没有可用应用')
 */
export async function aiRun(provider: string, task: AiTask, input: string, call: CallFn = bridgeCall): Promise<AiRunResult> {
  if (!isNativeAvailable()) throw new NativeUnavailableError(AI_METHODS.run)
  return call<AiRunResult>(AI_METHODS.run, { provider, task, input }, NO_TIMEOUT)
}

/**
 * 翻译语言码（应用语言码，BCP-47 风格，如 `zh-CN`、`en`）。
 * 具体哪些码可用由模型决定；原生不认的码会返回 BAD_PARAMS。
 */
export type TranslateLang = string

/** `native.ai.translate` 的参数 */
export interface TranslateParams {
  /** 待翻译文本 */
  text: string
  /** 源语言；可为 `'auto'`（由模型自动识别，需模型声明 sourceAuto），目标不可 */
  src: TranslateLang | 'auto'
  /** 目标语言 */
  tgt: TranslateLang
  /** beam search 宽度 1~4，缺省由原生决定 */
  numBeams?: number
}

/** `native.ai.translate` 的结果 */
export interface TranslateResult {
  /** 译文 */
  text: string
  /** 耗时毫秒 */
  elapsedMs: number
  /** 模型标识，如 `nllb600m-un6-ccm-int4` */
  modelId: string
  /** 实际源语言（auto 时原样为 `'auto'`） */
  src: string
  /** 实际目标语言 */
  tgt: string
  /** 被识别出的应用语言码，按出现顺序去重；没识别出为空数组；`src` 不是 auto 时就是 `[src]` */
  detectedSrc: string[]
  /** 有句子的语言无法识别而被原样放进输出时为 true；`src` 不是 auto 时恒为 false */
  unrecognized: boolean
}

/** 支持取消的原生调用函数形状，便于注入测试 */
export type CancelableCallFn = <T = unknown>(method: string, params?: Record<string, unknown>, options?: CallOptions) => Promise<T>

/**
 * 本地翻译（NLLB）。长调用不设超时，可用 signal 取消。源语言可传 `'auto'` 自动识别，
 * 结果里的 `detectedSrc` / `unrecognized` 说明识别情况。
 *
 * 原生错误码原样抛出：BAD_PARAMS（文本过长或语言不支持）、NOT_READY（模型未就绪）、
 * INTERNAL、CANCELLED（被取消）。
 *
 * @param params 文本、源语言、目标语言与可选 numBeams
 * @param signal 取消信号，触发后调用以 CANCELLED 拒绝
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 译文与耗时
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @example const r = await aiTranslate({ text: 'hello', src: 'en', tgt: 'zh-CN' }, ac.signal)
 */
export async function aiTranslate(params: TranslateParams, signal?: AbortSignal, call: CancelableCallFn = bridgeCall): Promise<TranslateResult> {
  if (!isNativeAvailable()) throw new NativeUnavailableError(AI_METHODS.translate)
  const p: Record<string, unknown> = { text: params.text, src: params.src, tgt: params.tgt }
  if (params.numBeams !== undefined) p.numBeams = params.numBeams
  return call<TranslateResult>(AI_METHODS.translate, p, { ...NO_TIMEOUT, signal })
}

/** `native.ai.warmup` 的结果 */
export interface WarmupResult {
  /** 提供者 id */
  provider: string
  /** 模型会话是否已加载 */
  loaded: boolean
  /** 本次加载耗时毫秒（已加载时很小） */
  elapsedMs: number
}

/**
 * 预热：只加载模型会话、不翻译，已加载则幂等。长调用不设超时，可用 signal 取消。
 *
 * 原生错误码原样抛出：NOT_READY（模型未安装）、BAD_PARAMS、INTERNAL、CANCELLED，
 * 原生还没有该方法时为 UNKNOWN_METHOD；调用方一般静默忽略。
 *
 * @param provider 提供者 id，如 `local-nllb`
 * @param signal 取消信号
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 加载状态与耗时
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @example void aiWarmup('local-nllb', ac.signal).catch(() => {})
 */
export async function aiWarmup(provider: string, signal?: AbortSignal, call: CancelableCallFn = bridgeCall): Promise<WarmupResult> {
  if (!isNativeAvailable()) throw new NativeUnavailableError(AI_METHODS.warmup)
  return call<WarmupResult>(AI_METHODS.warmup, { provider }, { ...NO_TIMEOUT, signal })
}

/** `native.ai.unload` 的结果 */
export interface UnloadResult {
  /** 实际卸载掉的提供者 id */
  unloaded: string[]
}

/**
 * 卸载 AI 会话回收内存，幂等。
 *
 * @param provider 提供者 id；缺省卸载全部 AI 会话
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 实际卸载的提供者
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @example void aiUnload('local-nllb').catch(() => {})
 */
export async function aiUnload(provider?: string, call: CancelableCallFn = bridgeCall): Promise<UnloadResult> {
  if (!isNativeAvailable()) throw new NativeUnavailableError(AI_METHODS.unload)
  return call<UnloadResult>(AI_METHODS.unload, provider === undefined ? {} : { provider })
}
