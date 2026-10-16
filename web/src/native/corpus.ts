/**
 * 对联语料库封装，对应原生 `native.corpus.couplet.*`。
 *
 * 语料本体是 AI 中心里下载的数据包（`couplet-corpus`，zip，原生解压），这里只按池内下标取一副，
 * 不把几十 MB 文本读进页面；“随机且不重复”的算法在 `tools/couplet/cursor.ts`。
 */
import { call as bridgeCall, isNativeAvailable } from './bridge'
import { NativeUnavailableError } from './system'
import type { CallFn } from './model'

/** 语料包在模型清单里的 id（状态读 `useModelsStore().get(COUPLET_CORPUS_ID)`） */
export const COUPLET_CORPUS_ID = 'couplet-corpus'

/** 方法名常量 */
export const CORPUS_METHODS = {
  info: 'native.corpus.couplet.info',
  get: 'native.corpus.couplet.get',
} as const

/** 一个抽取池 */
export interface CorpusPool {
  /** 池编号（传给 {@link corpusGet}） */
  pool: number
  /** 池名：`全部`（不含挽联）或分类名 */
  name: string
  /** 池内对联数 */
  count: number
}

/** 语料库概况；未安装时只有 `ready: false` */
export interface CorpusInfo {
  /** 语料是否可读 */
  ready: boolean
  /** 总对联数（ready 时有） */
  count?: number
  /** 全部抽取池（ready 时有） */
  pools?: CorpusPool[]
}

/** 取到的一副对联 */
export interface CorpusCouplet {
  /** 全局序号 */
  id: number
  /** 上联 */
  up: string
  /** 下联 */
  down: string
  /** 推荐横批（推导值，不是原联真实横批） */
  banner: string
  /** 所属分类（可能多个） */
  cats: string[]
  /** 首选分类 */
  primary: string
}

/**
 * 读语料库概况。无宿主或原生没有该方法时返回 `{ ready: false }`。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 概况
 * @example const info = await corpusInfo(); if (info.ready) console.log(info.pools)
 */
export async function corpusInfo(call: CallFn = bridgeCall): Promise<CorpusInfo> {
  if (!isNativeAvailable()) return { ready: false }
  try {
    return await call<CorpusInfo>(CORPUS_METHODS.info, {})
  } catch (e) {
    const code = (e as { code?: string } | null)?.code
    if (code === 'UNKNOWN_METHOD' || code === 'NOT_READY') return { ready: false }
    throw e
  }
}

/**
 * 取某个池里第 index 副对联。
 *
 * @param pool 池编号（见 {@link CorpusPool.pool}）
 * @param index 池内下标，0 起，小于该池 count
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 一副对联
 * @throws NativeUnavailableError 不在 Arkli 容器内
 * @throws 原生错误 NOT_READY：语料未下载；BAD_PARAMS：池或下标越界；INTERNAL：语料包损坏
 * @example const c = await corpusGet(0, 12345)
 */
export async function corpusGet(pool: number, index: number, call: CallFn = bridgeCall): Promise<CorpusCouplet> {
  if (!isNativeAvailable()) throw new NativeUnavailableError(CORPUS_METHODS.get)
  return call<CorpusCouplet>(CORPUS_METHODS.get, { pool, index })
}
