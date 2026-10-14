import { writeBlobToCache, type PickedImage } from '@/shared/image-io'
import { AiNotReadyError } from '@/native/ai'

/** 写缓存函数形状，便于注入测试 */
export type WriteFn = (blob: Blob, name: string) => Promise<string>
/** 取 Blob 函数形状，便于注入测试 */
export type FetchBlobFn = (url: string) => Promise<Blob>

/** 通用失败提示 */
const FAIL_TEXT = '处理失败'

/**
 * 拿到可交给 `native.ai.*` 的缓存相对路径：
 * 原生选图自带 path 就直接用，否则把图读出来写进缓存。
 *
 * @param img 选中的图片
 * @param write 写缓存函数，默认 writeBlobToCache
 * @param fetchBlob 取 Blob 函数，默认走 fetch
 * @returns 缓存相对路径
 * @example const path = await resolveImagePath(img)
 */
export async function resolveImagePath(
  img: Pick<PickedImage, 'path' | 'url' | 'name'>,
  write: WriteFn = (b, n) => writeBlobToCache(b, n),
  fetchBlob: FetchBlobFn = async (u) => (await fetch(u)).blob(),
): Promise<string> {
  if (img.path) return img.path
  return write(await fetchBlob(img.url), img.name)
}

/**
 * 把调用 AI 的错误转成给用户看的中文提示。
 *
 * @param e 捕获的错误
 * @returns 提示文案；AiNotReadyError 固定为「模型未就绪」
 * @example showToast(aiErrorText(e))
 */
export function aiErrorText(e: unknown): string {
  if (e instanceof AiNotReadyError) return e.message
  const msg = (e as { message?: string } | null)?.message
  return msg ? `${FAIL_TEXT}：${msg}` : FAIL_TEXT
}
