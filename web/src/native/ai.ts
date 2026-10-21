/**
 * 本地 AI 能力封装：OCR、超分、人像抠图、人脸融合、黑白上色。
 * 对应原生 `native.ai.*`。模型运行时（MNN / sherpa-mnn）由原生侧提供，页面只管调用与降级。
 *
 * 所有 `path` 都是缓存相对路径：页面先用 `writeBlobToCache` 写进去，
 * 结果路径用 {@link fetchAiResult} 以 `/files/<path>` 取回为 Blob。
 *
 * 没有宿主、原生返回 UNKNOWN_METHOD / NOT_READY、或 status 里该模型为 false 时，
 * 统一抛 {@link AiNotReadyError}，页面据此展示「模型未就绪」。
 */
import { call as bridgeCall, isNativeAvailable, type CallOptions } from './bridge'
import { NativeUnavailableError } from './system'
import { AI_METHODS } from './aiMethods'

/** 原生调用函数形状，便于注入测试 */
export type CallFn = <T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<T>

export { AI_METHODS }

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

/** OCR 结果（`native.ai.ocr` / `native.ai.invoke` 的 `ocr` 任务） */
export interface OcrResult {
  /** 文字块，按阅读顺序 */
  blocks: OcrBlock[]
  /** 送进识别的图宽（`box` 坐标系的基准；原图过大时是降采样后的宽） */
  width: number
  /** 送进识别的图高 */
  height: number
  /** 总耗时毫秒（含解码） */
  elapsedMs: number
  /** 其中识别部分毫秒 */
  inferMs?: number
  /** 模型标识，如 `ppocrv6-small-mnn-fp16` */
  modelId?: string
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
  /** 需要的模型（或任务名，如 `couplet`） */
  readonly model: AiModel | AiTask

  /**
   * @param model 需要的模型名或任务名
   */
  constructor(model: AiModel | AiTask) {
    super('模型未就绪')
    this.name = 'AiNotReadyError'
    this.model = model
  }
}

/** 全部为 false 的状态 */
function emptyStatus(): AiStatus {
  return { models: { ocr: false, upscale: false, classify: false, matte: false, fuse: false, colorize: false } }
}

/** 原生“已取消”错误码 */
export const AI_CODE_CANCELLED = 'CANCELLED'

/**
 * 是不是主动取消（原生回 CANCELLED，或本地 AbortController 触发的 AbortError）；取消不该弹失败提示。
 *
 * @param e 捕获到的错误
 * @returns 是取消为 true
 * @example if (isAiCancelled(e)) return
 */
export function isAiCancelled(e: unknown): boolean {
  const x = e as { code?: string; name?: string } | null
  return x?.code === AI_CODE_CANCELLED || x?.name === 'AbortError'
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
 * 文字识别（本地 PP-OCRv6 small，中英文由同一个模型一并识别）。第一个按统一协议新增的任务：转调 `native.ai.invoke` 并钉住 `native.ai.ocr` 入口，
 * 不看 `native.ai.status` 桩，模型状态由 AI 目录（`useAiCatalog('ocr')`）读取。长调用不设超时，可用 signal 取消。
 *
 * @param path 图片缓存相对路径
 * @param signal 取消信号，触发后调用以 CANCELLED 拒绝
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 文字块与识别图尺寸
 * @throws AiNotReadyError 无宿主、方法不存在或模型未就绪
 * @example const r = await aiOcr('cache/out/a.jpg')
 */
export async function aiOcr(path: string, signal?: AbortSignal, call: CancelableCallFn = bridgeCall): Promise<OcrResult> {
  if (!isNativeAvailable()) throw new AiNotReadyError('ocr')
  try {
    return await aiInvoke('ocr', { path }, { entry: AI_METHODS.ocr, signal }, call)
  } catch (e) {
    if (isNotReadyError(e)) throw new AiNotReadyError('ocr')
    throw e
  }
}

/**
 * 对联（本地 GPT-2，上联进、等长下联出）。转调 `native.ai.invoke` 并钉住 `native.ai.couplet` 入口，模型状态由 AI 目录读取。
 * 长调用不设超时，可用 signal 取消。
 *
 * @param text 上联，1~14 字，只含汉字与允许的标点
 * @param options 采样选项（temperature / topK / seed），不传用默认
 * @param signal 取消信号，触发后调用以 CANCELLED 拒绝
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 下联与耗时
 * @throws AiNotReadyError 无宿主、方法不存在或模型未就绪；BAD_PARAMS（上联不合法、参数超界）原样抛出
 * @example const r = await aiCouplet('春风送暖入屠苏', { temperature: 0 }); // r.text 与上联等长
 */
export async function aiCouplet(
  text: string,
  options: AiCoupletOptions = {},
  signal?: AbortSignal,
  call: CancelableCallFn = bridgeCall,
): Promise<CoupletResult> {
  if (!isNativeAvailable()) throw new AiNotReadyError('couplet')
  try {
    return await aiInvoke('couplet', { text }, { entry: AI_METHODS.couplet, options, signal }, call)
  } catch (e) {
    if (isNotReadyError(e)) throw new AiNotReadyError('couplet')
    throw e
  }
}

/**
 * 抠图（本地 MODNet 人像 / U2Net-p 通用）。转调 `native.ai.invoke` 并钉住 `native.ai.matting` 入口，模型状态由 AI 目录读取。
 * 长调用不设超时，可用 signal 取消；一次前向无法中途打断，取消最迟约 0.6~0.8 秒后生效。
 *
 * @param path 图片缓存相对路径
 * @param mode 模式：`portrait` 人像、`general` 通用
 * @param signal 取消信号，触发后调用以 CANCELLED 拒绝
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @param refine 边缘细化强度；不传则不带该字段，原生按缺省（强）处理
 * @returns 带透明通道的 PNG 路径与尺寸、耗时
 * @throws AiNotReadyError 无宿主、方法不存在或该模式的模型未就绪；BAD_PARAMS 原样抛出
 * @example const r = await aiMatting('cache/pick/a.jpg', 'portrait'); // r.path 是透明 PNG
 * @example await aiMatting('cache/pick/a.jpg', 'portrait', undefined, undefined, 'light') // 轻档细化
 */
export async function aiMatting(
  path: string,
  mode: MattingMode,
  signal?: AbortSignal,
  call: CancelableCallFn = bridgeCall,
  refine?: MattingRefine,
): Promise<MattingResult> {
  if (!isNativeAvailable()) throw new AiNotReadyError('matting')
  try {
    return await aiInvoke('matting', refine ? { path, mode, refine } : { path, mode }, { entry: AI_METHODS.matting, signal }, call)
  } catch (e) {
    if (isNotReadyError(e)) throw new AiNotReadyError('matting')
    throw e
  }
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
  /** 模型标识，如 `siglip2-mnn-w8` */
  modelId: string
}

/** 识物默认返回条数 */
const DEFAULT_IMAGE_TOP_K = 3

/**
 * 本地识物（垃圾分类，SigLIP2 MNN int8）：对一张缓存图片给出 top-k 物品与分类概率。
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
    // 钉住识图入口，与原先直接调 native.ai.classify 一致
    return await aiInvoke('classifyImage', { path }, { entry: AI_METHODS.classify, options: { topK } }, call)
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
export type AiTask = 'summarize' | 'proofread' | 'rewrite' | 'describeImage' | 'prompt' | 'translate' | 'classifyImage' | 'ocr' | 'couplet' | 'matting' | 'logoSymbol'

/** 提供者不可用的原因（未知值按字符串透传，页面不认识就当「不可用」） */
export type AiUnavailableReason = 'no_handler' | 'unsupported_device' | 'not_installed' | 'not_configured' | (string & {})

/** AI 层（决策 0005）：L1 本地小模型 / L2 本地大模型 / L3 本机 AI / L4 远端 API */
export type AiLayer = 'L1' | 'L2' | 'L3' | 'L4'

/** 任务入口：执行该任务要调的桥方法，取 `AI_METHODS.run/translate/classify/ocr/couplet/matting`（未知值按字符串透传） */
export type AiEntry = (typeof AI_METHODS)['run' | 'translate' | 'classify' | 'ocr' | 'couplet' | 'matting' | 'logoSymbol'] | (string & {})

/** 一项任务的约束，由原生给出（前端不再自己写语言清单） */
export interface AiOfferConstraints {
  /** 翻译：支持的应用语言码 */
  languages?: string[]
  /** 翻译：源语言可否为 `auto` */
  sourceAuto?: boolean
  /** 翻译：该提供者能译的原文字数上限（缺省时按入口上限 2000）；对联：上联字数上限（含标点） */
  maxChars?: number
  /** 翻译：是否接受束宽 `numBeams`；为 false 时传了会报 BAD_PARAMS */
  allowNumBeams?: boolean
  /** 文本生成：允许的预设 */
  presets?: AiPreset[]
  /** 文本生成与对联：温度范围（含端点），0 表示贪心 */
  temperature?: AiRange
  /** 文本生成与对联：topK 范围（含端点） */
  topK?: AiRange
  /** 文本生成：是否允许额外传 `system`（即便允许，也只有 `prompt` 预设可传） */
  allowSystem?: boolean
}

/** 数值范围（含端点） */
export interface AiRange {
  /** 下限 */
  min: number
  /** 上限 */
  max: number
}

/** 提供者对一项任务的报价：做什么任务、走哪个桥方法、带什么约束 */
export interface AiOffer {
  /** 任务 */
  task: AiTask
  /** 该走的桥方法，如 `native.ai.translate` */
  entry: AiEntry
  /** 约束，没有则省略 */
  constraints?: AiOfferConstraints
}

/** 参数控件类型 */
export type AiParamKind = 'slider' | 'stepper' | 'switch' | 'select'

/** 参数生效范围：call 下次调用生效 / session 需重建会话 */
export type AiParamScope = 'call' | 'session'

/** 可调参数定义（范围、默认值、控件形态、生效范围等） */
export interface AiParamSpec {
  /** 稳定标识，如 "temperature"、"numBeams" */
  key: string
  /** 展示标签 */
  label: string
  /** 一句话说明 */
  desc: string
  /** 控件形态 */
  kind: AiParamKind
  /** 默认值；switch 为 0/1，select 有 optionValues 时为真实值，否则为选项下标 */
  default: number
  /** 最小值 */
  min: number
  /** 最大值 */
  max: number
  /** 步长 */
  step: number
  /** 选项列表，select 专用 */
  options?: string[]
  /** select 各档对应的真实值，与 options 等长；有它时存取都用真实值，options 只管显示 */
  optionValues?: number[]
  /** 是否折叠进“高级” */
  advanced: boolean
  /** 生效范围：call 下次调用生效 / session 需重建会话 */
  scope: AiParamScope
  /** 只作用于哪些任务或预设（如 prompt） */
  applyTo?: string[]
}

/** `native.ai.params.*` 的返回状态 */
export interface AiParamsState {
  /** 提供者 id */
  provider: string
  /** 参数定义列表 */
  specs: AiParamSpec[]
  /** 全部 key 的当前生效值 */
  values: Record<string, number>
}

/** 一个 AI 提供者 */
export interface AiProviderInfo {
  /** 稳定标识，如 `intent-handoff` */
  id: string
  /** 展示名 */
  displayName: string
  /** 所属层；旧原生没有此字段 */
  layer?: AiLayer
  /** 当前是否可用 */
  available: boolean
  /** 不可用时的原因 */
  reason?: AiUnavailableReason
  /** 支持的任务 */
  tasks: AiTask[]
  /** 每项任务的报价（入口与约束），与 `tasks` 同源；旧原生没有此字段 */
  offers?: AiOffer[]
  /** 本地模型类提供者才有：清单里的模型 id，对应 `native.model.*` */
  modelId?: string
  /** 本地模型类提供者才有：模型已安装且 sha256 校验通过 */
  downloaded?: boolean
  /** 本地模型类提供者才有：磁盘占用字节（含未完成的 .part） */
  sizeBytes?: number
  /** 本地模型类提供者才有：是否正在下载或校验 */
  downloading?: boolean
  /** 是否持有可预热/卸载的模型会话（`native.ai.warmup` / `unload` 能用）；旧原生没有此字段 */
  session?: boolean
  /** 可调参数定义列表；没有则省略 */
  params?: AiParamSpec[]
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

/**
 * 取提供者对某任务的报价；指定入口时还要入口一致。旧原生不带 `offers`，一律视为没有报价。
 *
 * @param p 提供者
 * @param task 任务
 * @param entry 要求的入口；省略表示不限
 * @returns 报价，没有为 undefined
 * @example offerOf(qwen, 'translate', AI_METHODS.translate)?.constraints?.languages // ['zh-CN', 'en', ...]
 */
export function offerOf(p: AiProviderInfo, task: AiTask, entry?: AiEntry): AiOffer | undefined {
  return (p.offers ?? []).find((o) => o.task === task && (!entry || o.entry === entry))
}

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
  // task 可以是任意任务（含交接的 translate），超出 AiTaskMap 的强类型，走同一条 invoke 通道并钉住 run 入口
  return invokeRaw<AiRunResult>(task, { text: input }, { provider, entry: AI_METHODS.run }, call)
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
  /**
   * 指定翻译提供者 id（`native.ai.providers` 里声明了 translate 的，如 `local-nllb`、`local-qwen`）；
   * 缺省由原生按注册顺序取第一个能做语言对翻译的（现为 `local-nllb`）
   */
  provider?: string
}

/** `native.ai.translate` 的结果 */
export interface TranslateResult {
  /** 译文 */
  text: string
  /** 耗时毫秒 */
  elapsedMs: number
  /** 模型标识，如 `nllb600m-un6-mnn-w6` */
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
 * 带语言对的翻译，缺省本地 NLLB，可用 `params.provider` 指定其他翻译提供者（如 `local-qwen`）。长调用不设超时，可用 signal 取消。源语言可传 `'auto'` 自动识别，
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
  const options = params.numBeams === undefined ? undefined : { numBeams: params.numBeams }
  // 钉住语言对入口：指定了没有语言对接口的提供者（交接）时照旧报 BAD_PARAMS，不会悄悄交接出去
  return aiInvoke(
    'translate',
    { text: params.text, src: params.src, tgt: params.tgt },
    { provider: params.provider, entry: AI_METHODS.translate, options, signal },
    call,
  )
}

/** 经 run 端口的文本任务的输入 */
export interface AiTextInput {
  /** 输入文本，去空白后非空、≤ 5 万字符 */
  text: string
}

/** 翻译的输入：语言对与原文（`provider` 放调用选项，`numBeams` 放 `options`） */
export type AiTranslateInput = Pick<TranslateParams, 'text' | 'src' | 'tgt'>

/** 识图的输入 */
export interface AiClassifyInput {
  /** 图片缓存相对路径，如 `cache/pick/a.jpg` */
  path: string
}

/** 文字识别的输入 */
export interface AiOcrInput {
  /** 图片缓存相对路径，如 `cache/pick/a.jpg` */
  path: string
}

/** 对联的输入 */
export interface AiCoupletInput {
  /** 上联，1~14 字；只允许汉字与 `，。、；：！？,.;:!?`（标点在下联同位照抄），含英文字母、数字、括号报 BAD_PARAMS */
  text: string
}

/** 对联的附加选项，不传的用默认；范围以提供者报价的 `constraints` 为准 */
export interface AiCoupletOptions {
  /** 采样温度 0~2，0 表示贪心，默认 0.8 */
  temperature?: number
  /** 温度采样的候选数 1~200，默认 40 */
  topK?: number
  /** 随机种子（非负整数，不超过 2^53-1），给定则结果可复现；缺省随机 */
  seed?: number
}

/** 对联结果（`native.ai.couplet` / `native.ai.invoke` 的 `couplet` 任务） */
export interface CoupletResult {
  /** 下联，与上联等长，标点位与上联相同 */
  text: string
  /** 总耗时毫秒（含首次加载） */
  elapsedMs: number
  /** 模型标识，如 `couplet-gpt2-mnn-w6` */
  modelId: string
}

/** 抠图模式：人像（MODNet）/ 通用主体（U2Net-p）/ 人像 v2（PP-MattingV2，实验）/ 通用高精（BiRefNet-lite，实验），各对应一个本地模型 */
export type MattingMode = 'portrait' | 'general' | 'ppmatting' | 'birefnet'

/** 边缘细化强度：关 / 轻 / 标准 / 强（原生缺省“强”） */
export type MattingRefine = 'off' | 'light' | 'standard' | 'strong'

/** 抠图的输入 */
export interface AiMattingInput {
  /** 图片缓存相对路径，如 `cache/pick/a.jpg` */
  path: string
  /** 模式；原生据此选提供者（`local-matting-portrait` / `local-matting-general`） */
  mode: MattingMode
  /** 边缘细化强度，可省，缺省 `strong` */
  refine?: MattingRefine
}

/** 抠图结果（`native.ai.matting` / `native.ai.invoke` 的 `matting` 任务） */
export interface MattingResult {
  /** 带透明通道的 PNG 的缓存相对路径，如 `cache/out/matting_portrait_ab12cd34.png` */
  path: string
  /** PNG 宽（大图会被原生收敛到最长边 3072） */
  width: number
  /** PNG 高 */
  height: number
  /** 使用的模式 */
  mode: MattingMode
  /** 总耗时毫秒（含首次加载、解码、合成与编码） */
  elapsedMs: number
  /** 其中 Rust 侧耗时毫秒（缩放、前向、alpha 缩回、边缘细化） */
  inferMs: number
  /** 其中边缘细化（引导滤波 + 前景色估计）耗时毫秒，已含在 inferMs 内 */
  refineMs: number
  /** 模型标识，如 `matting-modnet-mnn-fp32` */
  modelId: string
}

/** logo 符号生成的输入（`native.ai.logoSymbol`） */
export interface AiLogoInput {
  /** 英文提示词（原生 trim 后非空、UTF-8 不超过 2000 字节） */
  prompt: string
  /** 随机种子，0~2^53-1 的整数；缺省由原生随机并在结果里回报 */
  seed?: number
  /** 是否去掉模型自己画的外圈，缺省 true */
  removeRing?: boolean
}

/** logo 符号的质量闸门原因码（原生给的字符串，未知值按字符串透传） */
export type LogoGateReason = 'empty' | 'ink_low' | 'ink_high' | 'concentric' | 'fragments' | 'specks' | 'small' | 'off_center' | (string & {})

/** logo 符号生成结果（`native.ai.logoSymbol`） */
export interface LogoSymbolResult {
  /** 单色符号的 `<path .../>` 片段拼接（fill 为 #000000，坐标系 512x512，各 path 自带 transform="translate(x,y)"）；空图为 null */
  svgPaths: string | null
  /** path 条数 */
  pathCount: number
  /** 质量闸门是否通过（没过时 svgPaths 仍可能有值） */
  gateOk: boolean
  /** 闸门未通过的原因码 */
  gateReasons: LogoGateReason[]
  /** 本次使用的种子 */
  seed: number
  /** 驻留方式：resident 常驻 / per_stage 每段即卸 */
  residency: string
  /** 总耗时毫秒 */
  elapsedMs: number
  /** 模型标识，如 `sdxs512-mnn-w8` */
  modelId: string
}

/** 没有附加选项的任务 */
type NoOptions = Record<string, never>

/** 文本生成预设：决定指令模板、system 与默认采样，与文本生成类任务同名 */
export type AiPreset = 'summarize' | 'proofread' | 'rewrite' | 'prompt'

/** 文本生成类任务（经 run 端口）的附加选项，不传的沿用预设默认；范围与权限以提供者报价的 `constraints` 为准 */
export interface AiGenerateOptions {
  /** 预设，缺省按任务；摘要、校对、改写默认贪心，提示词问答默认温度 0.7、topK 20 */
  preset?: AiPreset
  /** 额外 system 提示，1~2000 字符；**只有 `prompt` 预设允许**，其它预设传了报 BAD_PARAMS */
  system?: string
  /** 采样温度 0~1.5，0 表示贪心；非生成式提供者（如交接）收到会报 BAD_PARAMS */
  temperature?: number
  /** 温度采样的候选数 1~100 */
  topK?: number
}

/**
 * 各任务的强类型输入、附加选项与结果（按任务缺省端口的形状；原生 `native.ai.invoke` 按任务分派到对应端口）。
 * `describeImage` 还没有端口，暂不收录。
 */
export interface AiTaskMap {
  /** 摘要（run 端口） */
  summarize: { input: AiTextInput; options: AiGenerateOptions; output: AiRunResult }
  /** 校对（run 端口） */
  proofread: { input: AiTextInput; options: AiGenerateOptions; output: AiRunResult }
  /** 改写（run 端口） */
  rewrite: { input: AiTextInput; options: AiGenerateOptions; output: AiRunResult }
  /** 自由提示词（run 端口） */
  prompt: { input: AiTextInput; options: AiGenerateOptions; output: AiRunResult }
  /** 带语言对的翻译（translate 端口） */
  translate: { input: AiTranslateInput; options: { numBeams?: number }; output: TranslateResult }
  /** 识图（classify 端口） */
  classifyImage: { input: AiClassifyInput; options: { topK?: number }; output: ImageClassifyResult }
  /** 文字识别（ocr 端口） */
  ocr: { input: AiOcrInput; options: NoOptions; output: OcrResult }
  /** 对联（couplet 专用端口，文本生成类但不走 run） */
  couplet: { input: AiCoupletInput; options: AiCoupletOptions; output: CoupletResult }
  /** 抠图（matting 专用端口，输出带透明通道的 PNG 路径） */
  matting: { input: AiMattingInput; options: NoOptions; output: MattingResult }
  /** logo 符号生成（logoSymbol 专用端口，英文提示词进、单色 SVG path 出） */
  logoSymbol: { input: AiLogoInput; options: NoOptions; output: LogoSymbolResult }
}

/** {@link aiInvoke} 的调用选项 */
export interface AiInvokeOptions<T extends keyof AiTaskMap> {
  /** 指定提供者 id；缺省由原生取该任务缺省端口的第一个候选 */
  provider?: string
  /**
   * 钉住入口（桥方法名，取 `AI_METHODS.run/translate/classify/ocr/couplet/matting/logoSymbol`）。不钉时：指定了 provider 就走它报价里的入口，
   * 否则走任务的缺省入口。**注意**：只点名交接类提供者（它的 translate 报价入口是 run）而不钉入口时，结果是 {@link AiRunResult}
   * 形状而不是 {@link TranslateResult}；需要确定形状就钉住入口（旧封装都钉了）。
   */
  entry?: AiEntry
  /** 任务的附加选项，如翻译的 `numBeams`、识图的 `topK` */
  options?: AiTaskMap[T]['options']
  /** 取消信号，触发后调用以 CANCELLED 拒绝 */
  signal?: AbortSignal
}

/** 发一次 `native.ai.invoke`，只带有值的字段；不检查宿主（调用方负责） */
function invokeRaw<R>(
  task: string,
  input: object,
  opts: { provider?: string; entry?: AiEntry; options?: object; signal?: AbortSignal },
  call: CancelableCallFn,
): Promise<R> {
  const p: Record<string, unknown> = { task, input }
  if (opts.provider !== undefined) p.provider = opts.provider
  if (opts.entry !== undefined) p.entry = opts.entry
  if (opts.options && Object.keys(opts.options).length) p.options = opts.options
  return call<R>(AI_METHODS.invoke, p, { ...NO_TIMEOUT, signal: opts.signal })
}

/**
 * 统一 AI 入口：按任务分派到原生的强类型端口（翻译、识图、文本 run……），输入输出按 {@link AiTaskMap} 强类型。
 * 长调用不设超时，可用 signal 取消。原生错误码原样抛出，语义与旧方法一致：BAD_PARAMS（参数、提供者或入口不对）、
 * NOT_READY（提供者当前不可用）、INTERNAL、CANCELLED；旧原生没有该方法时为 UNKNOWN_METHOD。
 *
 * @param task 任务
 * @param input 该任务的输入
 * @param opts 提供者、入口、附加选项、取消信号
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 该任务的结果
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @example const r = await aiInvoke('translate', { text: 'hi', src: 'en', tgt: 'zh-CN' }, { provider: 'local-qwen', signal })
 * @example const s = await aiInvoke('summarize', { text: long }, { provider: 'local-qwen' }) // s.text
 */
export async function aiInvoke<T extends keyof AiTaskMap>(
  task: T,
  input: AiTaskMap[T]['input'],
  opts: AiInvokeOptions<T> = {},
  call: CancelableCallFn = bridgeCall,
): Promise<AiTaskMap[T]['output']> {
  if (!isNativeAvailable()) throw new NativeUnavailableError(AI_METHODS.invoke)
  return invokeRaw<AiTaskMap[T]['output']>(task, input, opts, call)
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
 * 预热：只加载模型会话、不推理，已加载则幂等。长调用不设超时，可用 signal 取消。
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

/**
 * 读取提供者的可调参数定义与当前值。
 *
 * @param provider 提供者 id
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 参数定义与当前生效值
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @example const { specs, values } = await aiParamsGet('local-qwen')
 */
export async function aiParamsGet(provider: string, call: CancelableCallFn = bridgeCall): Promise<AiParamsState> {
  if (!isNativeAvailable()) throw new NativeUnavailableError(AI_METHODS.paramsGet)
  return call<AiParamsState>(AI_METHODS.paramsGet, { provider })
}

/**
 * 设置提供者的参数值，整批原子生效。
 *
 * @param provider 提供者 id
 * @param values 要修改的键值对
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 修改后的全部参数定义与最新生效值
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @example const next = await aiParamsSet('local-qwen', { temperature: 0.5 })
 */
export async function aiParamsSet(
  provider: string,
  values: Record<string, number>,
  call: CancelableCallFn = bridgeCall,
): Promise<AiParamsState> {
  if (!isNativeAvailable()) throw new NativeUnavailableError(AI_METHODS.paramsSet)
  return call<AiParamsState>(AI_METHODS.paramsSet, { provider, values })
}

/**
 * 重置提供者的参数为默认值。
 *
 * @param provider 提供者 id
 * @param keys 要重置的键名列表，不传表示重置该提供者的全部参数
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 重置后的全部参数定义与最新生效值
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @example const reset = await aiParamsReset('local-qwen', ['temperature'])
 */
export async function aiParamsReset(
  provider: string,
  keys?: string[],
  call: CancelableCallFn = bridgeCall,
): Promise<AiParamsState> {
  if (!isNativeAvailable()) throw new NativeUnavailableError(AI_METHODS.paramsReset)
  return call<AiParamsState>(AI_METHODS.paramsReset, keys ? { provider, keys } : { provider })
}

