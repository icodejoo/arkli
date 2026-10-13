// 哈希计算：MD5 / SHA-1 / SHA-256 / SHA-512，文本按 UTF-8，文件分块增量计算
import { md5, sha1 } from '@noble/hashes/legacy.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** 支持的算法名 */
export type HashAlgo = 'md5' | 'sha1' | 'sha256' | 'sha512'

/** 算法展示顺序与显示名 */
export const HASH_ALGOS: ReadonlyArray<{ id: HashAlgo; label: string }> = [
  { id: 'md5', label: 'MD5' },
  { id: 'sha1', label: 'SHA-1' },
  { id: 'sha256', label: 'SHA-256' },
  { id: 'sha512', label: 'SHA-512' },
]

/** 文件分块大小（2MB），内存恒定 */
export const FILE_CHUNK_BYTES = 2 * 1024 * 1024

/** 超过这个大小提示"可能要等一会儿"（200MB） */
export const BIG_FILE_BYTES = 200 * 1024 * 1024

/** 一组哈希结果（小写 hex） */
export type HashDigests = Record<HashAlgo, string>

/** 增量哈希器的最小接口（noble 的 create() 返回值满足） */
interface Hasher {
  update(data: Uint8Array): unknown
  digest(): Uint8Array
}

/** 各算法的哈希器工厂 */
const FACTORIES: Record<HashAlgo, () => Hasher> = {
  md5: () => md5.create(),
  sha1: () => sha1.create(),
  sha256: () => sha256.create(),
  sha512: () => sha512.create(),
}

/**
 * 按 UTF-8 计算文本的全部哈希。
 *
 * @param text 原文
 * @returns 各算法的小写 hex
 * @example
 * hashText('abc').md5 // '900150983cd24fb0d6963f7d28e17f72'
 */
export function hashText(text: string): HashDigests {
  return hashBytes(new TextEncoder().encode(text))
}

/**
 * 计算一段字节的全部哈希。
 *
 * @param bytes 原始字节
 * @returns 各算法的小写 hex
 */
export function hashBytes(bytes: Uint8Array): HashDigests {
  const out = {} as HashDigests
  for (const { id } of HASH_ALGOS) {
    const h = FACTORIES[id]()
    h.update(bytes)
    out[id] = bytesToHex(h.digest())
  }
  return out
}

/** 可分块读取的数据源（File / Blob 满足） */
export interface ChunkSource {
  /** 总字节数 */
  size: number
  /** 截取 [start, end) 区间 */
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

/** 文件哈希选项 */
export interface HashFileOptions {
  /** 分块大小，默认 FILE_CHUNK_BYTES */
  chunkBytes?: number
  /** 进度回调：已读字节数、总字节数 */
  onProgress?: (done: number, total: number) => void
  /** 返回 true 时中止计算 */
  isCancelled?: () => boolean
}

/**
 * 分块读取并增量计算文件哈希，内存占用与文件大小无关。
 *
 * @param source File 或 Blob
 * @param opts 分块、进度与取消
 * @returns 各算法的小写 hex；被取消时返回 null
 * @example
 * const d = await hashFile(file, { onProgress: (a, b) => (pct.value = a / b) })
 */
export async function hashFile(source: ChunkSource, opts: HashFileOptions = {}): Promise<HashDigests | null> {
  const chunk = opts.chunkBytes ?? FILE_CHUNK_BYTES
  const hashers = HASH_ALGOS.map(({ id }) => [id, FACTORIES[id]()] as const)
  let done = 0
  while (done < source.size) {
    if (opts.isCancelled?.()) return null
    const end = Math.min(done + chunk, source.size)
    const buf = new Uint8Array(await source.slice(done, end).arrayBuffer())
    for (const [, h] of hashers) h.update(buf)
    done = end
    opts.onProgress?.(done, source.size)
  }
  const out = {} as HashDigests
  for (const [id, h] of hashers) out[id] = bytesToHex(h.digest())
  return out
}

/**
 * 按大小写偏好格式化 hex。
 *
 * @param hex 小写 hex
 * @param upper 是否大写
 */
export function formatHex(hex: string, upper: boolean): string {
  return upper ? hex.toUpperCase() : hex
}

/**
 * 用期望值去比对结果，找出匹配的算法（忽略大小写和首尾空白）。
 *
 * @param digests 计算结果
 * @param expected 用户粘贴的期望值
 * @returns 匹配的算法 id；空输入或都不匹配返回 null
 * @example
 * matchExpected(hashText('abc'), '900150983CD24FB0D6963F7D28E17F72') // 'md5'
 */
export function matchExpected(digests: HashDigests, expected: string): HashAlgo | null {
  const e = expected.trim().toLowerCase()
  if (!e) return null
  return HASH_ALGOS.find(({ id }) => digests[id] === e)?.id ?? null
}
