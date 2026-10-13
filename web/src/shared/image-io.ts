/**
 * 图片类工具共用的取图 / 处理 / 存图：
 * 有原生宿主时走 native.file.*，没有（桌面浏览器调试）时退回 input[type=file] 与 a[download]。
 */
import { call as bridgeCall, isNativeAvailable } from '@/native/bridge'
import { exceedsCanvas, extToMime, halvingSteps, type Size } from './image-calc'

/** 原生单块写入字节数（与 openWrite 返回的 chunkBytes 默认一致） */
export const DEFAULT_CHUNK_BYTES = 1024 * 1024

/** 原生缓存路径在页面里的同源前缀 */
const FILES_URL_PREFIX = '/files/'

/** 逐段拼字符串的切片长度，避免 apply 参数过多爆栈 */
const STRING_SLICE = 0x8000

/** 浏览器下载后延迟回收 ObjectURL 的毫秒数 */
const REVOKE_DELAY_MS = 10_000

/** 选图时 input 的 accept */
const IMAGE_ACCEPT = 'image/*'

/** 写入帧编码 */
export type FrameEncoding = 'latin1' | 'base64'

/** 选中的一张图片 */
export interface PickedImage {
  /** 文件名 */
  name: string
  /** MIME */
  mime: string
  /** 字节数 */
  size: number
  /** 按 EXIF 摆正后的宽，探测失败为 0 */
  width: number
  /** 按 EXIF 摆正后的高，探测失败为 0 */
  height: number
  /** 可直接给 img / fetch 用的同源地址 */
  url: string
  /** 原生缓存相对路径（如 cache/pick/a.jpg），仅有宿主时有值，可交给 native.image.compress */
  path?: string
  /** 释放 ObjectURL 等资源（原生路径下为空操作） */
  release: () => void
}

/** 原生 pick 返回的图片项 */
interface NativePickItem {
  /** 项类型 */
  kind: string
  /** 缓存相对路径，如 cache/pick/a.jpg */
  path?: string
  /** 页面可读地址 */
  url?: string
  /** 文件名 */
  name: string
  /** MIME */
  mime: string
  /** 字节数 */
  size: number
  /** 宽（已摆正） */
  width?: number
  /** 高（已摆正） */
  height?: number
}

/** 原生调用函数形状，便于注入测试 */
export type CallFn = <T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<T>

/** 图片过大：像素数超出 Canvas 安全范围 */
export class ImageTooLargeError extends Error {
  /** 固定错误码，便于调用方判断 */
  readonly code = 'TOO_LARGE'
  /** @param width 宽 @param height 高 */
  constructor(width: number, height: number) {
    super(`图片过大（${width}x${height}），请先缩小`)
    this.name = 'ImageTooLargeError'
  }
}

/**
 * 把字节转成按编码约定的字符串帧。
 *
 * @param bytes 原始字节
 * @param encoding latin1（每字符一字节）或 base64
 * @returns 字符串帧
 */
export function encodeChunk(bytes: Uint8Array, encoding: FrameEncoding): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += STRING_SLICE) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STRING_SLICE) as unknown as number[])
  }
  return encoding === 'base64' ? btoa(bin) : bin
}

/**
 * 按 openWrite 返回的 encodings 选帧编码：优先 latin1，兜底 base64。
 *
 * @param supported 原生声明支持的编码，缺省视为仅 base64
 */
export function pickEncoding(supported: string[] | undefined): FrameEncoding {
  return supported?.includes('latin1') ? 'latin1' : 'base64'
}

/**
 * 把 Blob 分块串行写进原生缓存（openWrite → write × N → closeWrite，每块等确认）。
 * 中途失败会尽力 abort 句柄再抛出原错误。
 *
 * @param blob 要写的内容
 * @param name 文件名
 * @param call 原生调用函数，默认走 bridge
 * @returns 缓存相对路径（如 cache/out/h1/a.jpg）
 * @example const path = await writeBlobToCache(blob, 'a.jpg')
 */
export async function writeBlobToCache(blob: Blob, name: string, call: CallFn = bridgeCall): Promise<string> {
  const open = await call<{ handle: string; chunkBytes?: number; encodings?: string[] }>('native.file.openWrite', {
    name,
    size: blob.size,
  })
  const chunk = open.chunkBytes && open.chunkBytes > 0 ? open.chunkBytes : DEFAULT_CHUNK_BYTES
  const encoding = pickEncoding(open.encodings)
  try {
    let seq = 0
    for (let off = 0; off < blob.size; seq++) {
      const bytes = new Uint8Array(await blob.slice(off, off + chunk).arrayBuffer())
      await call('native.file.write', { handle: open.handle, seq, offset: off, data: encodeChunk(bytes, encoding), encoding })
      off += bytes.length
    }
    const done = await call<{ path: string }>('native.file.closeWrite', { handle: open.handle, size: blob.size })
    return done.path
  } catch (e) {
    await call('native.file.closeWrite', { handle: open.handle, abort: true }).catch(() => undefined)
    throw e
  }
}

/** 探测图片显示尺寸（EXIF 已摆正），失败返回 0x0 */
function probeSize(url: string): Promise<Size> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = url
  })
}

/** 浏览器兜底：弹出 input[type=file] 选图，取消时 Promise 不会结束（旧 WebView 无 cancel 事件） */
function pickViaInput(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = IMAGE_ACCEPT
    input.multiple = multiple
    input.onchange = () => resolve(Array.from(input.files ?? []))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}

/**
 * 选图：有宿主走 native.file.pick，否则退回 input[type=file]。
 * 用户取消返回空数组；原生 failed 的文件会在 onFailed 里回调。
 *
 * @param opts multiple 是否多选；max 最多张数（原生上限 50）；onFailed 部分文件失败的回调
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 选中的图片，宽高已探测
 * @example const imgs = await pickImages({ multiple: true, max: 9 })
 */
export async function pickImages(
  opts: { multiple?: boolean; max?: number; onFailed?: (failed: Array<{ name: string; message: string }>) => void } = {},
  call: CallFn = bridgeCall,
): Promise<PickedImage[]> {
  const { multiple = false, max = 20 } = opts
  if (isNativeAvailable()) {
    const res = await call<{ items: NativePickItem[]; failed: Array<{ name: string; message: string }> }>(
      'native.file.pick',
      { mime: IMAGE_ACCEPT, multiple, max },
      { timeoutMs: 0 },
    )
    if (res.failed?.length) opts.onFailed?.(res.failed)
    const list: PickedImage[] = []
    for (const it of res.items.filter((i) => i.kind === 'image')) {
      const url = it.url || FILES_URL_PREFIX + (it.path ?? '')
      const size = it.width && it.height ? { width: it.width, height: it.height } : await probeSize(url)
      list.push({ name: it.name, mime: it.mime, size: it.size, ...size, url, path: it.path, release: () => undefined })
    }
    return list
  }
  const files = (await pickViaInput(multiple)).slice(0, max)
  return Promise.all(
    files.map(async (f) => {
      const url = URL.createObjectURL(f)
      const size = await probeSize(url)
      return { name: f.name, mime: f.type || extToMime(f.name), size: f.size, ...size, url, release: () => URL.revokeObjectURL(url) }
    }),
  )
}

/**
 * 解码成 ImageBitmap，按 EXIF 摆正。超过 Canvas 安全范围直接抛 ImageTooLargeError，不解码。
 * 用完务必 `bitmap.close()`。
 *
 * @param img 选中的图片
 * @returns 位图
 * @example const bmp = await loadBitmap(img); try { ... } finally { bmp.close() }
 */
export async function loadBitmap(img: PickedImage): Promise<ImageBitmap> {
  if (exceedsCanvas(img.width, img.height)) throw new ImageTooLargeError(img.width, img.height)
  const blob = await (await fetch(img.url)).blob()
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  } catch {
    // 老 WebView 不认 from-image，退回默认（新内核默认就会摆正）
    bmp = await createImageBitmap(blob)
  }
  if (exceedsCanvas(bmp.width, bmp.height)) {
    const { width, height } = bmp
    bmp.close()
    throw new ImageTooLargeError(width, height)
  }
  return bmp
}

/** 新建画布 */
export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

/** 释放画布位图内存（宽高置 0） */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

/**
 * 把位图缩放绘制到新画布；缩小超过一半时逐级减半，画质更好。
 *
 * @param src 源位图
 * @param width 目标宽
 * @param height 目标高
 * @param fill 底色（JPEG 去透明用），缺省保持透明
 * @returns 新画布，调用方负责 releaseCanvas
 */
export function drawScaled(src: ImageBitmap | HTMLCanvasElement, width: number, height: number, fill?: string): HTMLCanvasElement {
  const steps = halvingSteps(src.width, src.height, width, height)
  let from: ImageBitmap | HTMLCanvasElement = src
  for (let i = 0; i < steps.length; i++) {
    const last = i === steps.length - 1
    const c = createCanvas(steps[i].width, steps[i].height)
    const ctx = c.getContext('2d')!
    if (last && fill) {
      ctx.fillStyle = fill
      ctx.fillRect(0, 0, c.width, c.height)
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(from, 0, 0, c.width, c.height)
    if (from !== src) releaseCanvas(from as HTMLCanvasElement)
    from = c
  }
  return from as HTMLCanvasElement
}

/**
 * canvas.toBlob 的 Promise 版。浏览器不支持目标格式时会退回 PNG，请以返回 blob.type 为准。
 *
 * @param canvas 画布
 * @param mime 目标 MIME
 * @param quality 0~1，仅 JPEG/WebP 有效
 */
export function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('编码失败，图片可能过大'))), mime, quality)
  })
}

/** WebP 编码支持探测结果缓存 */
let webpOk: boolean | null = null

/** 当前 WebView 是否能把 Canvas 编码成 WebP */
export function webpEncodeSupported(): boolean {
  if (webpOk === null) {
    const c = createCanvas(1, 1)
    webpOk = c.toDataURL('image/webp').startsWith('data:image/webp')
    releaseCanvas(c)
  }
  return webpOk
}

/** 待保存的产物 */
export interface SaveItem {
  /** 文件名（含扩展名） */
  name: string
  /** 内容 */
  blob: Blob
}

/** 保存结果 */
export interface SaveResult {
  /** native 存进相册；download 触发浏览器下载 */
  mode: 'native' | 'download'
  /** 成功保存的张数 */
  saved: number
}

/** 浏览器兜底：用 a[download] 触发下载 */
function downloadBlob(item: SaveItem): void {
  const url = URL.createObjectURL(item.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = item.name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}

/**
 * 保存一批产物：有宿主时逐个写缓存（base64/latin1 串行分块）再一次 native.file.save 存相册；
 * 否则逐个触发浏览器下载。
 *
 * @param items 待保存产物
 * @param onProgress 写缓存进度回调（已写第几个，共几个）
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 保存方式与成功张数
 * @example await saveBlobs([{ name: 'a.jpg', blob }])
 */
export async function saveBlobs(
  items: SaveItem[],
  onProgress?: (done: number, total: number) => void,
  call: CallFn = bridgeCall,
): Promise<SaveResult> {
  if (!isNativeAvailable()) {
    items.forEach(downloadBlob)
    onProgress?.(items.length, items.length)
    return { mode: 'download', saved: items.length }
  }
  const saveItems: Array<{ path: string; name: string; mime: string }> = []
  for (let i = 0; i < items.length; i++) {
    const { blob, name } = items[i]
    const path = await writeBlobToCache(blob, name, call)
    saveItems.push({ path, name, mime: blob.type || extToMime(name) })
    onProgress?.(i + 1, items.length)
  }
  const res = await call<{ items: unknown[] }>('native.file.save', { items: saveItems }, { timeoutMs: 0 })
  return { mode: 'native', saved: res.items.length }
}

/**
 * 保存单个产物，等价于 saveBlobs 传一项。
 *
 * @param blob 内容
 * @param name 文件名
 */
export function saveBlob(blob: Blob, name: string): Promise<SaveResult> {
  return saveBlobs([{ blob, name }])
}
