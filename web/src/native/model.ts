/**
 * 本地模型下载管理封装，对应原生 `native.model.*`。
 *
 * 下载地址只来自随包清单，页面只传模型 id，拿不到也改不了 URL 与磁盘路径。
 * 宿主外的约定与 ai.ts 一致：`modelList` 无宿主或原生没有该方法时返回空列表；
 * 其余方法无宿主时抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall, isNativeAvailable } from './bridge'
import { NativeUnavailableError } from './system'

/** 原生调用函数形状，便于注入测试 */
export type CallFn = <T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<T>

/** 方法名常量 */
export const MODEL_METHODS = {
  list: 'native.model.list',
  status: 'native.model.status',
  ensure: 'native.model.ensure',
  cancel: 'native.model.cancel',
  remove: 'native.model.remove',
  verify: 'native.model.verify',
} as const

/** 原生推送事件：某模型状态或下载进度变化，data 同 {@link ModelStatus}（下载进度约 300 毫秒一条） */
export const MODEL_EVENT = 'model.changed'

/** 校验与删除耗时随文件大小增长，不设超时 */
const NO_TIMEOUT = { timeoutMs: 0 }

/** 模型状态：未安装 / 下载中 / 已安装 / 文件齐全但未校验 / 文件长度不对 */
export type ModelStateName = 'absent' | 'downloading' | 'installed' | 'unverified' | 'corrupt'

/** 最近一次下载失败的原因 */
export interface ModelError {
  /** 错误码：NO_SPACE / NETWORK / HASH_MISMATCH / SIZE_MISMATCH / SOURCE_REJECTED / INTERNAL（未知值透传） */
  code: string
  /** 给人看的简述 */
  message: string
}

/** 一个模型的状态 */
export interface ModelStatus {
  /** 模型 id，如 `siglip2-q4_half` */
  id: string
  /** 展示名 */
  displayName: string
  /** 清单版本 */
  version: string
  /** 状态 */
  state: ModelStateName
  /** 总字节数 */
  totalBytes: number
  /** 已落地字节数（取消后保留的 .part 也算，用于续传） */
  downloadedBytes: number
  /** 磁盘占用字节（含未完成的 .part） */
  diskBytes: number
  /** 下载中的阶段：download 下载、verify 校验 */
  phase?: 'download' | 'verify'
  /** 下载中的平均速度，字节/秒 */
  speedBps?: number
  /** 最近一次下载失败的原因；开始新下载或删除后清除 */
  error?: ModelError
}

/** `native.model.ensure` 的结果 */
export interface ModelEnsureResult extends ModelStatus {
  /** 本次调用是否真的启动了任务（已安装或已在下载为 false） */
  started: boolean
  /** 当前是否为计费网络；页面自行决定要不要提醒，原生不会拦截 */
  meteredHint: boolean
}

/** 无宿主时统一抛错 */
function requireHost(method: string): void {
  if (!isNativeAvailable()) throw new NativeUnavailableError(method)
}

/**
 * 列出清单里全部模型的状态。
 *
 * 无宿主或原生返回 UNKNOWN_METHOD 时视为没有模型；其他错误照常抛出。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 模型状态列表
 * @example const models = await modelList(); const used = models.reduce((n, m) => n + m.diskBytes, 0)
 */
export async function modelList(call: CallFn = bridgeCall): Promise<ModelStatus[]> {
  if (!isNativeAvailable()) return []
  try {
    const res = await call<{ models?: ModelStatus[] }>(MODEL_METHODS.list, {})
    return res?.models ?? []
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'UNKNOWN_METHOD') return []
    throw e
  }
}

/**
 * 查单个模型的状态（一次性快照；实时进度走 {@link MODEL_EVENT} 推送，由 `useModelsStore` 接收）。
 *
 * @param id 模型 id
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 状态
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @throws 原生错误 BAD_PARAMS：id 不在清单里
 * @example const s = await modelStatus('siglip2-q4_half')
 */
export async function modelStatus(id: string, call: CallFn = bridgeCall): Promise<ModelStatus> {
  requireHost(MODEL_METHODS.status)
  return call<ModelStatus>(MODEL_METHODS.status, { id })
}

/**
 * 确保模型就绪：已安装直接返回，下载中直接返回，否则在后台启动下载（有 .part 则续传）。幂等，立即返回。
 *
 * @param id 模型 id
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 状态加 `started`、`meteredHint`
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @throws 原生错误 BAD_PARAMS：id 不在清单里
 * @example const r = await modelEnsure('siglip2-q4_half'); if (r.meteredHint) tip('当前是移动网络')
 */
export async function modelEnsure(id: string, call: CallFn = bridgeCall): Promise<ModelEnsureResult> {
  requireHost(MODEL_METHODS.ensure)
  return call<ModelEnsureResult>(MODEL_METHODS.ensure, { id })
}

/**
 * 取消下载（幂等）。已下载的部分保留，下次 ensure 续传。
 *
 * @param id 模型 id
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 取消后的状态
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @example await modelCancel('siglip2-q4_half')
 */
export async function modelCancel(id: string, call: CallFn = bridgeCall): Promise<ModelStatus> {
  requireHost(MODEL_METHODS.cancel)
  return call<ModelStatus>(MODEL_METHODS.cancel, { id })
}

/**
 * 删除模型：取消进行中的下载、释放已加载的推理会话、删掉全部文件与 .part。
 *
 * @param id 模型 id
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 删除后的状态（absent、占用 0）
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @throws 原生错误 INTERNAL：有文件删不掉
 * @example await modelRemove('siglip2-q4_half')
 */
export async function modelRemove(id: string, call: CallFn = bridgeCall): Promise<ModelStatus> {
  requireHost(MODEL_METHODS.remove)
  return call<ModelStatus>(MODEL_METHODS.remove, { id }, NO_TIMEOUT)
}

/**
 * 重新计算 sha256 并更新状态；不通过的文件会被删除，`error.code` 为 HASH_MISMATCH。耗时与文件大小成正比。
 *
 * @param id 模型 id
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 校验后的状态
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @throws 原生错误 NOT_READY：正在下载
 * @example const s = await modelVerify('siglip2-q4_half'); if (s.state !== 'installed') tip('模型已损坏')
 */
export async function modelVerify(id: string, call: CallFn = bridgeCall): Promise<ModelStatus> {
  requireHost(MODEL_METHODS.verify)
  return call<ModelStatus>(MODEL_METHODS.verify, { id }, NO_TIMEOUT)
}
