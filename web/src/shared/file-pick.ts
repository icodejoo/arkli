/**
 * 选普通文件（文本、文档等非图片/视频）：有宿主走 native.file.pick 的系统文档选择器，否则退回 input[type=file]。
 * App 的 WebView 没接 onShowFileChooser，页面里的 <input type=file> 在宿主内点了没反应，所以宿主内必须走原生。
 */
import { call as bridgeCall, isNativeAvailable } from '@/native/bridge'
import type { CallFn } from '@/native/system'

/** 原生选择方法名 */
const PICK_METHOD = 'native.file.pick'
/** 原生缓存文件的页面读取前缀（原生没给 url 时用 path 拼） */
const FILES_URL_PREFIX = '/files/'
/** 默认不限类型 */
export const ANY_MIME = '*/*'

/** 原生返回的一项（只取用得到的字段） */
interface NativeFileItem {
  /** 项类型：file / image / video */
  kind: string
  /** 缓存相对路径 */
  path?: string
  /** 页面可读地址 */
  url?: string
  /** 文件名 */
  name: string
  /** MIME */
  mime: string
}

/** 选文件入参 */
export interface PickFileOptions {
  /** 宿主内传给系统文档选择器的 mime，可逗号分隔多个（如 `text/*,application/json`），默认 `*\/*` */
  mime?: string
  /** 无宿主时 input 的 accept，默认不限 */
  accept?: string
  /** 原生拷贝失败（如超过 64MB）的回调 */
  onFailed?: (failed: Array<{ name: string; message: string }>) => void
}

/**
 * 选一个文件，读成 File 返回。宿主内文件 ≤ 64MB（原生限制），超了走 onFailed。
 *
 * @param opts 见 {@link PickFileOptions}
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 选中的文件；用户取消或全部失败返回 null
 * @example const f = await pickFile({ accept: '.txt,.md' }); if (f) text.value = await f.text()
 */
export async function pickFile(opts: PickFileOptions = {}, call: CallFn = bridgeCall): Promise<File | null> {
  if (!isNativeAvailable()) return pickViaInput(opts.accept)
  const res = await call<{ items: NativeFileItem[]; failed?: Array<{ name: string; message: string }> }>(
    PICK_METHOD,
    { mime: opts.mime ?? ANY_MIME },
    { timeoutMs: 0 },
  )
  if (res.failed?.length) opts.onFailed?.(res.failed)
  const it = res.items.find((i) => i.kind !== 'video' && (i.url || i.path))
  if (!it) return null
  const blob = await (await fetch(it.url || FILES_URL_PREFIX + it.path)).blob()
  return new File([blob], it.name, { type: it.mime || blob.type })
}

/** 无宿主兜底：临时 input 选一个文件，取消返回 null */
function pickViaInput(accept?: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}
